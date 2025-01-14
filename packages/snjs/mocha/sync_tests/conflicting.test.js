/* eslint-disable no-undef */
import { BaseItemCounts } from '../lib/BaseItemCounts.js'
import * as Factory from '../lib/factory.js'
import { createSyncedNoteWithTag } from '../lib/Items.js'
import * as Utils from '../lib/Utils.js'
chai.use(chaiAsPromised)
const expect = chai.expect

describe('online conflict handling', function () {
  this.timeout(Factory.TenSecondTimeout)

  const syncOptions = {
    checkIntegrity: true,
    awaitAll: true,
  }

  beforeEach(async function () {
    localStorage.clear()
    this.expectedItemCount = BaseItemCounts.DefaultItemsWithAccount

    this.context = await Factory.createAppContextWithFakeCrypto('AppA')
    await this.context.launch()

    this.application = this.context.application
    this.email = this.context.email
    this.password = this.context.password

    Factory.disableIntegrityAutoHeal(this.application)

    await this.context.register()

    this.sharedFinalAssertions = async function () {
      expect(this.application.sync.isOutOfSync()).to.equal(false)
      const items = this.application.items.items
      expect(items.length).to.equal(this.expectedItemCount)
      const rawPayloads = await this.application.storage.getAllRawPayloads()
      expect(rawPayloads.length).to.equal(this.expectedItemCount)
    }
  })

  afterEach(async function () {
    if (!this.application.dealloced) {
      await this.context.deinit()
    }
    localStorage.clear()
  })

  function createDirtyPayload(contentType) {
    const params = {
      uuid: UuidGenerator.GenerateUuid(),
      content_type: contentType,
      content: {
        foo: 'bar',
      },
    }
    const payload = new DecryptedPayload({
      ...params,
      dirty: true,
      dirtyIndex: getIncrementedDirtyIndex(),
    })
    return payload
  }

  it('components should not be duplicated under any circumstances', async function () {
    const payload = createDirtyPayload(ContentType.TYPES.Component)

    const item = await this.application.mutator.emitItemFromPayload(payload, PayloadEmitSource.LocalChanged)

    this.expectedItemCount++

    await this.application.sync.sync(syncOptions)

    /** First modify the item without saving so that our local contents digress from the server's */
    await this.application.mutator.changeItem(item, (mutator) => {
      mutator.mutableContent.foo = `${Math.random()}`
    })

    await Factory.changePayloadTimeStampAndSync(
      this.application,
      item.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {
        foo: 'zar',
      },
      syncOptions,
    )

    expect(this.application.items.items.length).to.equal(this.expectedItemCount)
    await this.sharedFinalAssertions()
  })

  it('items keys should not be duplicated under any circumstances', async function () {
    const payload = createDirtyPayload(ContentType.TYPES.ItemsKey)
    const item = await this.application.mutator.emitItemFromPayload(payload, PayloadEmitSource.LocalChanged)
    this.expectedItemCount++
    await this.application.sync.sync(syncOptions)
    /** First modify the item without saving so that
     * our local contents digress from the server's */
    await this.application.mutator.changeItem(item, (mutator) => {
      mutator.title = `${Math.random()}`
    })

    await Factory.changePayloadTimeStampAndSync(
      this.application,
      item.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {
        foo: 'zar',
      },
      syncOptions,
    )

    expect(this.application.items.items.length).to.equal(this.expectedItemCount)
    await this.sharedFinalAssertions()
  })

  it('should create conflicted copy if incoming server item attempts to overwrite local dirty item', async function () {
    // create an item and sync it
    const note = await Factory.createMappedNote(this.application)
    this.expectedItemCount++
    await this.application.mutator.setItemDirty(note)
    await this.application.sync.sync(syncOptions)

    const rawPayloads = await this.application.storage.getAllRawPayloads()
    expect(rawPayloads.length).to.equal(this.expectedItemCount)

    const originalValue = note.title
    const dirtyValue = `${Math.random()}`

    /** Modify nonsense first to get around strategyWhenConflictingWithItem with previousRevision check  */
    await this.application.mutator.changeNote(note, (mutator) => {
      mutator.title = 'any'
    })

    await this.application.mutator.changeNote(note, (mutator) => {
      // modify this item locally to have differing contents from server
      mutator.title = dirtyValue
      // Intentionally don't change updated_at. We want to simulate a chaotic case where
      // for some reason we receive an item with different content but the same updated_at.
      // note.updated_at = Factory.yesterday();
    })

    // Download all items from the server, which will include this note.
    await this.application.sync.clearSyncPositionTokens()
    await this.application.sync.sync({
      ...syncOptions,
      awaitAll: true,
    })

    // We expect this item to be duplicated
    this.expectedItemCount++
    expect(this.application.items.getDisplayableNotes().length).to.equal(2)

    const allItems = this.application.items.items
    expect(allItems.length).to.equal(this.expectedItemCount)

    const originalItem = this.application.items.findItem(note.uuid)
    const duplicateItem = allItems.find((i) => i.content.conflict_of === note.uuid)

    expect(originalItem.title).to.equal(dirtyValue)
    expect(duplicateItem.title).to.equal(originalValue)
    expect(originalItem.title).to.not.equal(duplicateItem.title)

    const newRawPayloads = await this.application.storage.getAllRawPayloads()
    expect(newRawPayloads.length).to.equal(this.expectedItemCount)
    await this.sharedFinalAssertions()
  })

  it('should handle sync conflicts by duplicating differing data', async function () {
    // create an item and sync it
    const note = await Factory.createMappedNote(this.application)
    await Factory.markDirtyAndSyncItem(this.application, note)
    this.expectedItemCount++

    const rawPayloads = await this.application.storage.getAllRawPayloads()
    expect(rawPayloads.length).to.equal(this.expectedItemCount)
    /** First modify the item without saving so that
     * our local contents digress from the server's */
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = `${Math.random()}`
    })

    await Factory.changePayloadTimeStampAndSync(
      this.application,
      note.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {
        title: `${Math.random()}`,
      },
      syncOptions,
    )

    // We expect this item to be duplicated
    this.expectedItemCount++
    const allItems = this.application.items.items
    expect(allItems.length).to.equal(this.expectedItemCount)

    const note1 = this.application.items.getDisplayableNotes()[0]
    const note2 = this.application.items.getDisplayableNotes()[1]
    expect(note1.content.title).to.not.equal(note2.content.title)
    await this.sharedFinalAssertions()
  })

  it('basic conflict with clearing local state', async function () {
    const note = await Factory.createMappedNote(this.application)
    await Factory.markDirtyAndSyncItem(this.application, note)
    this.expectedItemCount += 1
    /** First modify the item without saving so that
     * our local contents digress from the server's */
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = `${Math.random()}`
    })

    await Factory.changePayloadTimeStampAndSync(
      this.application,
      note.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {
        title: `${Math.random()}`,
      },
      syncOptions,
    )

    this.expectedItemCount++
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)

    // clear sync token, clear storage, download all items, and ensure none of them have error decrypting
    await this.application.sync.clearSyncPositionTokens()
    await this.application.storage.clearAllPayloads()
    await this.application.payloads.resetState()
    await this.application.items.resetState()
    await this.application.sync.sync(syncOptions)

    expect(this.application.items.items.length).to.equal(this.expectedItemCount)
    await this.sharedFinalAssertions()
  })

  it('should duplicate item if saving a modified item and clearing our sync token', async function () {
    let note = await Factory.createMappedNote(this.application)

    await this.application.mutator.setItemDirty(note)
    await this.application.sync.sync(syncOptions)

    this.expectedItemCount++

    const newTitle = `${Math.random()}`

    /** First modify the item without saving so that our local contents digress from the server's */
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = `${Math.random()}`
    })

    await Factory.changePayloadTimeStamp(
      this.application,
      note.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {
        title: newTitle,
      },
      syncOptions,
    )

    // We expect this item to be duplicated
    this.expectedItemCount++

    await this.application.sync.clearSyncPositionTokens()
    await this.application.sync.sync(syncOptions)

    note = this.application.items.findItem(note.uuid)

    // We expect the item title to be the new title, and not rolled back to original value
    expect(note.content.title).to.equal(newTitle)

    const allItems = this.application.items.items
    expect(allItems.length).to.equal(this.expectedItemCount)
    await this.sharedFinalAssertions()
  })

  it('should handle sync conflicts by not duplicating same data', async function () {
    const note = await Factory.createMappedNote(this.application)
    this.expectedItemCount++
    await this.application.mutator.setItemDirty(note)
    await this.application.sync.sync(syncOptions)

    // keep item as is and set dirty
    await this.application.mutator.setItemDirty(note)

    // clear sync token so that all items are retrieved on next sync
    this.application.sync.clearSyncPositionTokens()

    await this.application.sync.sync(syncOptions)
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)
    await this.sharedFinalAssertions()
  })

  it('clearing conflict_of on two clients simultaneously should keep us in sync', async function () {
    const note = await Factory.createMappedNote(this.application)
    await this.application.mutator.setItemDirty(note)
    this.expectedItemCount++

    await this.application.changeAndSaveItem(
      note,
      (mutator) => {
        // client A
        mutator.mutableContent.conflict_of = 'foo'
      },
      undefined,
      undefined,
      syncOptions,
    )

    // client B
    await this.application.sync.clearSyncPositionTokens()
    await this.application.mutator.changeItem(
      note,
      (mutator) => {
        mutator.mutableContent.conflict_of = 'bar'
      },
      undefined,
      undefined,
      syncOptions,
    )

    // conflict_of is a key to ignore when comparing content, so item should
    // not be duplicated.
    await this.application.sync.sync(syncOptions)
    await this.sharedFinalAssertions()
  })

  it('setting property on two clients simultaneously should create conflict', async function () {
    const note = await Factory.createMappedNote(this.application)
    await this.application.mutator.setItemDirty(note)
    this.expectedItemCount++

    await this.application.changeAndSaveItem(
      note,
      (mutator) => {
        // client A
        mutator.mutableContent.foo = 'foo'
      },
      undefined,
      undefined,
      syncOptions,
    )
    /** First modify the item without saving so that
     * our local contents digress from the server's */
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = `${Math.random()}`
    })
    // client B
    await this.application.sync.clearSyncPositionTokens()

    await Factory.changePayloadTimeStampAndSync(
      this.application,
      note.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {
        foo: 'bar',
      },
      syncOptions,
    )

    this.expectedItemCount++

    await this.sharedFinalAssertions()
  })

  it('if server says deleted but client says not deleted, keep server state', async function () {
    const note = await Factory.createMappedNote(this.application)
    const originalPayload = note.payloadRepresentation()
    this.expectedItemCount++
    await this.application.mutator.setItemDirty(note)
    await this.application.sync.sync(syncOptions)
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)

    // client A
    await this.application.mutator.setItemToBeDeleted(note)
    await this.application.sync.sync(syncOptions)
    this.expectedItemCount--
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)

    // client B
    await this.application.sync.clearSyncPositionTokens()
    // Add the item back and say it's not deleted
    const mutatedPayload = new DecryptedPayload({
      ...originalPayload,
      deleted: false,
      updated_at: Factory.yesterday(),
    })
    await this.application.mutator.emitItemsFromPayloads([mutatedPayload], PayloadEmitSource.LocalChanged)
    const resultNote = this.application.items.findItem(note.uuid)
    expect(resultNote.uuid).to.equal(note.uuid)
    await this.application.mutator.setItemDirty(resultNote)
    await this.application.sync.sync(syncOptions)

    // We expect that this item is now gone for good, and a duplicate has not been created.
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)
    await this.sharedFinalAssertions()
  })

  it('if server says not deleted but client says deleted, keep server state', async function () {
    const note = await Factory.createMappedNote(this.application)
    await this.application.mutator.setItemDirty(note)
    this.expectedItemCount++

    // client A
    await this.application.sync.sync(syncOptions)
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)

    // client B
    await this.application.sync.clearSyncPositionTokens()

    // This client says this item is deleted, but the server is saying its not deleted.
    // In this case, we want to keep the server copy.
    await Factory.changePayloadTimeStampDeleteAndSync(
      this.application,
      note.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      syncOptions,
    )

    // We expect that this item maintained.
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)
    await this.sharedFinalAssertions()
  })

  it('should create conflict if syncing an item that is stale', async function () {
    let note = await Factory.createMappedNote(this.application)
    await this.application.mutator.setItemDirty(note)
    await this.application.sync.sync(syncOptions)
    note = this.application.items.findItem(note.uuid)
    expect(note.dirty).to.equal(false)
    this.expectedItemCount++
    /** First modify the item without saving so that
     * our local contents digress from the server's */
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = `${Math.random()}`
    })

    note = await Factory.changePayloadTimeStampAndSync(
      this.application,
      note.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {
        text: 'Stale text',
      },
      syncOptions,
    )

    expect(note.dirty).to.equal(false)

    // We expect now that the item was conflicted
    this.expectedItemCount++

    const rawPayloads = await this.application.storage.getAllRawPayloads()
    expect(rawPayloads.length).to.equal(this.expectedItemCount)
    for (const payload of rawPayloads) {
      expect(payload.dirty).to.not.be.ok
    }
    await this.sharedFinalAssertions()
  })

  it('creating conflict with exactly equal content should keep us in sync', async function () {
    const note = await Factory.createMappedNote(this.application)
    await this.application.mutator.setItemDirty(note)
    this.expectedItemCount++

    await this.application.sync.sync(syncOptions)

    await Factory.changePayloadTimeStampAndSync(
      this.application,
      note.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {},
      syncOptions,
    )

    expect(this.application.items.items.length).to.equal(this.expectedItemCount)
    await this.sharedFinalAssertions()
  })

  /** Temporarily skipping due to long run time */
  it.skip('handles stale data in bulk', async function () {
    /** This number must be greater than the pagination limit per sync request.
     * For example if the limit per request is 150 items sent/received, this number should
     * be something like 160. */
    const largeItemCount = SyncUpDownLimit + 10
    await Factory.createManyMappedNotes(this.application, largeItemCount)

    /** Upload */
    this.application.sync.sync(syncOptions)
    await this.context.awaitNextSucessfulSync()

    this.expectedItemCount += largeItemCount
    const items = this.application.items.items
    expect(items.length).to.equal(this.expectedItemCount)

    /**
     * We want to see what will happen if we upload everything we have to
     * the server as dirty, with no sync token, so that the server also
     * gives us everything it has.
     */
    this.application.sync.lockSyncing()
    const yesterday = Factory.yesterday()
    for (const note of this.application.items.getDisplayableNotes()) {
      /** First modify the item without saving so that
       * our local contents digress from the server's */
      await this.application.mutator.changeItem(note, (mutator) => {
        mutator.text = '1'
      })

      await Factory.changePayloadTimeStamp(this.application, note.payload, Factory.dateToMicroseconds(yesterday), {
        text: '2',
      })

      // We expect all the notes to be duplicated.
      this.expectedItemCount++
    }
    this.application.sync.unlockSyncing()

    await this.application.sync.clearSyncPositionTokens()
    this.application.sync.sync(syncOptions)
    await this.context.awaitNextSucessfulSync()

    expect(this.application.items.getDisplayableNotes().length).to.equal(largeItemCount * 2)
    await this.sharedFinalAssertions()
  }).timeout(60000)

  it('duplicating an item should maintian its relationships', async function () {
    const payload1 = Factory.createStorageItemPayload(ContentType.TYPES.Tag)
    const payload2 = Factory.createStorageItemPayload(ContentType.TYPES.UserPrefs)
    this.expectedItemCount -= 1 /** auto-created user preferences  */
    await this.application.mutator.emitItemsFromPayloads([payload1, payload2], PayloadEmitSource.LocalChanged)
    this.expectedItemCount += 2
    let tag = this.application.items.getItems(ContentType.TYPES.Tag)[0]
    let userPrefs = this.application.items.getItems(ContentType.TYPES.UserPrefs)[0]
    expect(tag).to.be.ok
    expect(userPrefs).to.be.ok

    tag = await this.application.mutator.changeItem(tag, (mutator) => {
      mutator.e2ePendingRefactor_addItemAsRelationship(userPrefs)
    })

    await this.application.mutator.setItemDirty(userPrefs)
    userPrefs = this.application.items.findItem(userPrefs.uuid)

    expect(this.application.items.itemsReferencingItem(userPrefs).length).to.equal(1)
    expect(this.application.items.itemsReferencingItem(userPrefs)).to.include(tag)

    await this.application.sync.sync(syncOptions)
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)

    tag = await Factory.changePayloadTimeStamp(
      this.application,
      tag.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {
        title: `${Math.random()}`,
      },
    )

    await this.application.sync.sync({ ...syncOptions, awaitAll: true })

    // fooItem should now be conflicted and a copy created
    this.expectedItemCount++
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)
    const rawPayloads = await this.application.storage.getAllRawPayloads()
    expect(rawPayloads.length).to.equal(this.expectedItemCount)

    const fooItems = this.application.items.getItems(ContentType.TYPES.Tag)
    const fooItem2 = fooItems[1]

    expect(fooItem2.content.conflict_of).to.equal(tag.uuid)
    // Two items now link to this original object
    const referencingItems = this.application.items.itemsReferencingItem(userPrefs)
    expect(referencingItems.length).to.equal(2)
    expect(referencingItems[0]).to.not.equal(referencingItems[1])

    expect(this.application.items.itemsReferencingItem(tag).length).to.equal(0)
    expect(this.application.items.itemsReferencingItem(fooItem2).length).to.equal(0)

    expect(tag.content.references.length).to.equal(1)
    expect(fooItem2.content.references.length).to.equal(1)
    expect(userPrefs.content.references.length).to.equal(0)

    expect(this.application.items.getDirtyItems().length).to.equal(0)
    for (const item of this.application.items.items) {
      expect(item.dirty).to.not.be.ok
    }
    await this.sharedFinalAssertions()
  })

  it('when a note is conflicted, its tags should not be duplicated.', async function () {
    /**
     * If you have a note and a tag, and the tag has 1 reference to the note,
     * and you import the same two items, except modify the note value so that
     * a duplicate is created, we expect only the note to be duplicated,
     * and the tag not to.
     */
    let tag = await Factory.createMappedTag(this.application)
    let note = await Factory.createMappedNote(this.application)
    tag = await this.application.changeAndSaveItem(
      tag,
      (mutator) => {
        mutator.e2ePendingRefactor_addItemAsRelationship(note)
      },
      undefined,
      undefined,
      syncOptions,
    )
    await this.application.mutator.setItemDirty(note)
    this.expectedItemCount += 2

    await this.application.sync.sync(syncOptions)

    // conflict the note
    const newText = `${Math.random()}`

    /** First modify the item without saving so that our local contents digress from the server's */
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = `${Math.random()}`
    })

    note = await Factory.changePayloadTimeStampAndSync(
      this.application,
      note.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {
        text: newText,
      },
      syncOptions,
    )

    // conflict the tag but keep its content the same
    tag = await Factory.changePayloadTimeStampAndSync(
      this.application,
      tag.payload,
      Factory.dateToMicroseconds(Factory.yesterday()),
      {},
      syncOptions,
    )

    /**
     * We expect now that the total item count has went up by just 1 (the note),
     * and not 2 (the note and tag)
     */
    this.expectedItemCount += 1
    expect(this.application.items.items.length).to.equal(this.expectedItemCount)
    expect(tag.content.references.length).to.equal(2)
    await this.sharedFinalAssertions()
  })

  it('succesful server side saving but dropped packet response should not create sync conflict', async function () {
    /**
     * 1. Initiate a change locally that is successfully saved by the server, but the client
     * drops the server response.
     * 2. Make a change to this note locally that then syncs and the response is successfully recorded.
     *
     * Expected result: no sync conflict is created
     */
    const note = await Factory.createSyncedNote(this.application)
    this.expectedItemCount++

    const baseTitle = 'base title'
    /** Change the note */
    const noteAfterChange = await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = baseTitle
    })
    await this.application.sync.sync()

    /** Simulate a dropped response by reverting the note back its post-change, pre-sync state */
    const retroNote = await this.application.mutator.emitItemFromPayload(noteAfterChange.payload)
    expect(retroNote.serverUpdatedAt.getTime()).to.equal(noteAfterChange.serverUpdatedAt.getTime())

    /** Change the item to its final title and sync */
    const finalTitle = 'final title'
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = finalTitle
    })
    await this.application.sync.sync()

    /** Expect that no duplicates have been created, and that the note's title is now finalTitle */
    expect(this.application.items.getDisplayableNotes().length).to.equal(1)
    const finalNote = this.application.items.findItem(note.uuid)
    expect(finalNote.title).to.equal(finalTitle)
    await this.sharedFinalAssertions()
  })

  it('receiving a decrypted item while the current local item is errored and dirty should overwrite local value', async function () {
    /**
     * An item can be marked as dirty (perhaps via a bulk dirtying operation) even if it is errored,
     * but it can never be sent to the server if errored. If we retrieve an item from the server
     * that we're able to decrypt, and the current base value is errored and dirty, we don't want to
     * create a conflict, but instead just have the server value replace the client value.
     */
    /**
     * Create a note and sync it with the server while its valid
     */
    const note = await Factory.createSyncedNote(this.application)
    this.expectedItemCount++

    /**
     * Mark the item as dirty and errored
     */
    const errorred = new EncryptedPayload({
      ...note.payload,
      content: '004:...',
      errorDecrypting: true,
      dirty: true,
    })
    await this.application.mutator.emitItemsFromPayloads([errorred], PayloadEmitSource.LocalChanged)

    /**
     * Retrieve this note from the server by clearing sync token
     */
    await this.application.sync.clearSyncPositionTokens()
    await this.application.sync.sync({
      ...syncOptions,
      awaitAll: true,
    })

    /**
     * Expect that the final result is just 1 note that is not errored
     */
    const resultNote = await this.application.items.findItem(note.uuid)
    expect(resultNote.errorDecrypting).to.not.be.ok
    expect(this.application.items.getDisplayableNotes().length).to.equal(1)
    await this.sharedFinalAssertions()
  })

  /** Temporarily skipping due to long run time */
  it.skip(
    'registering for account with bulk offline data belonging to another account should be error-free',
    async function () {
      /**
       * When performing a multi-page sync request where we are uploading data imported from a backup,
       * if the first page of the sync request returns conflicted items keys, we rotate their UUID.
       * The second page of sync waiting to be sent up is still encrypted with the old items key UUID.
       * This causes a problem because when that second page is returned as conflicts, we will be looking
       * for an items_key_id that no longer exists (has been rotated). Rather than modifying the entire
       * sync paradigm to allow multi-page requests to consider side-effects of each page, we will instead
       * take the approach of making sure the decryption function is liberal with regards to searching
       * for the right items key. It will now consider (as a result of this test) an items key as being
       * the correct key to decrypt an item if the itemskey.uuid == item.items_key_id OR if the itemsKey.duplicateOf
       * value is equal to item.items_key_id.
       */

      /** Create bulk data belonging to another account and sync */
      const largeItemCount = SyncUpDownLimit + 10
      await Factory.createManyMappedNotes(this.application, largeItemCount)
      await this.application.sync.sync(syncOptions)
      const priorData = this.application.items.items

      /** Register new account and import this same data */
      const newApp = await Factory.signOutApplicationAndReturnNew(this.application)
      await Factory.registerUserToApplication({
        application: newApp,
        email: Utils.generateUuid(),
        password: Utils.generateUuid(),
      })
      await newApp.mutator.emitItemsFromPayloads(priorData.map((i) => i.payload))
      await newApp.sync.markAllItemsAsNeedingSyncAndPersist()
      await newApp.sync.sync(syncOptions)
      expect(newApp.payloads.invalidPayloads.length).to.equal(0)
      await Factory.safeDeinit(newApp)
    },
  ).timeout(80000)

  it('importing data belonging to another account should not result in duplication', async function () {
    /** Create primary account and export data */
    await createSyncedNoteWithTag(this.application)
    let backupFile = await this.application.createEncryptedBackupFileForAutomatedDesktopBackups()
    /** Sort matters, and is the cause of the original issue, where tag comes before the note */
    backupFile.items = [
      backupFile.items.find((i) => i.content_type === ContentType.TYPES.ItemsKey),
      backupFile.items.find((i) => i.content_type === ContentType.TYPES.Tag),
      backupFile.items.find((i) => i.content_type === ContentType.TYPES.Note),
    ]
    backupFile = JSON.parse(JSON.stringify(backupFile))
    /** Register new account and import this same data */
    const newApp = await Factory.signOutApplicationAndReturnNew(this.application)
    const password = this.password
    await Factory.registerUserToApplication({
      application: newApp,
      email: Utils.generateUuid(),
      password: password,
    })
    Factory.handlePasswordChallenges(newApp, password)
    await newApp.importData(backupFile, true)
    expect(newApp.items.getDisplayableTags().length).to.equal(1)
    expect(newApp.items.getDisplayableNotes().length).to.equal(1)
    await Factory.safeDeinit(newApp)
  }).timeout(10000)

  it('importing notes + tags belonging to another account should keep correct associations', async function () {
    /**
     * The original issue can be replicated when an export contains a tag with two notes,
     * where the two notes are first listed in the backup, then the tag.
     */
    /** Create primary account and export data */
    await createSyncedNoteWithTag(this.application)
    const tag = this.application.items.getDisplayableTags()[0]
    const note2 = await Factory.createMappedNote(this.application)
    await this.application.changeAndSaveItem(tag, (mutator) => {
      mutator.e2ePendingRefactor_addItemAsRelationship(note2)
    })
    let backupFile = await this.application.createEncryptedBackupFileForAutomatedDesktopBackups()
    backupFile.items = [
      backupFile.items.find((i) => i.content_type === ContentType.TYPES.ItemsKey),
      backupFile.items.filter((i) => i.content_type === ContentType.TYPES.Note)[0],
      backupFile.items.filter((i) => i.content_type === ContentType.TYPES.Note)[1],
      backupFile.items.find((i) => i.content_type === ContentType.TYPES.Tag),
    ]
    backupFile = JSON.parse(JSON.stringify(backupFile))
    /** Register new account and import this same data */
    const newApp = await Factory.signOutApplicationAndReturnNew(this.application)
    const password = this.password
    await Factory.registerUserToApplication({
      application: newApp,
      email: Utils.generateUuid(),
      password: password,
    })
    Factory.handlePasswordChallenges(newApp, password)
    await newApp.importData(backupFile, true)
    const newTag = newApp.items.getDisplayableTags()[0]
    const notes = newApp.items.referencesForItem(newTag)
    expect(notes.length).to.equal(2)
    await Factory.safeDeinit(newApp)
  }).timeout(10000)

  it('server should prioritize updated_at_timestamp over updated_at for sync, if provided', async function () {
    /**
     * As part of SSRB to SSJS migration, server should prefer to use updated_at_timestamp
     * over updated_at for sync conflict logic. The timestamps are more accurate and support
     * microsecond precision, versus date objects which only go up to milliseconds.
     */
    const note = await Factory.createSyncedNote(this.application)
    this.expectedItemCount++

    /** First modify the item without saving so that
     * our local contents digress from the server's */
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = `${Math.random()}`
    })
    /**
     * Create a modified payload that has updated_at set to old value, but updated_at_timestamp
     * set to new value. Then send to server. If the server conflicts, it means it's incorrectly ignoring
     * updated_at_timestamp and looking at updated_at.
     */
    const modified = note.payload.copy({
      updated_at: new Date(0),
      content: {
        ...note.content,
        title: Math.random(),
      },
      dirty: true,
    })
    await this.application.mutator.emitItemFromPayload(modified)
    await this.application.sync.sync()
    expect(this.application.items.getDisplayableNotes().length).to.equal(1)
    await this.sharedFinalAssertions()
  })

  it('conflict should be created if updated_at_timestamp is not exactly equal to servers', async function () {
    const note = await Factory.createSyncedNote(this.application)
    this.expectedItemCount++

    /** First modify the item without saving so that
     * our local contents digress from the server's */
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = `${Math.random()}`
    })
    const modified = note.payload.copy({
      updated_at_timestamp: note.payload.updated_at_timestamp - 1,
      content: {
        ...note.content,
        title: Math.random(),
      },
      dirty: true,
    })
    this.expectedItemCount++
    await this.application.mutator.emitItemFromPayload(modified)
    await this.application.sync.sync()
    expect(this.application.items.getDisplayableNotes().length).to.equal(2)
    await this.sharedFinalAssertions()
  })

  it('conflict where server updated_at_timestamp is less than base updated_at should not result in infinite loop', async function () {
    /**
     * While this shouldn't happen, I've seen this happen locally where a single UserPrefs object has a timestamp of A
     * on the server, and A + 10 on the client side. Somehow the client had a newer timestamp than the server. The
     * server rejects any change if the timestamp is not exactly equal. When we use the KeepBase strategy during conflict
     * resolution, we keep the base item, but give it the timestamp of the server item, so that the server accepts it.
     * However, RemoteDataConflict would only take the server's timestamp if it was greater than the base's timestamp.
     * Because this was not the case, the client kept sending up its own base timestamp and the server kept rejecting it,
     * and it never resolved. The fix made here was to take the server's timestamp no matter what, even if it is less than client's.
     */
    const note = await Factory.createSyncedNote(this.application)
    this.expectedItemCount++

    /** First modify the item without saving so that our local contents digress from the server's */
    await this.application.mutator.changeItem(note, (mutator) => {
      mutator.title = `${Math.random()}`
    })
    const modified = note.payload.copy({
      updated_at_timestamp: note.payload.updated_at_timestamp + 1,
      content: {
        ...note.content,
        title: Math.random(),
      },
      dirty: true,
    })
    this.expectedItemCount++
    await this.application.mutator.emitItemFromPayload(modified)
    await this.application.sync.sync()
    expect(this.application.items.getDisplayableNotes().length).to.equal(2)
    await this.sharedFinalAssertions()
  })

  it('conflicting should not over resolve', async function () {
    /**
     * Before refactoring to use dirtyIndex instead of dirtiedDate, sometimes an item could be dirtied
     * and begin sync at the exact same millisecond count (at least in the tests). In which case, the item
     * would be stillDirty after sync and would sync again. This test ensures that an item is only synced once
     * after it saves changes from conflicted items.
     */
    const contextA = this.context
    const contextB = await Factory.createAppContextWithFakeCrypto('AppB', contextA.email, contextA.password)

    contextA.disableIntegrityAutoHeal()
    contextB.disableIntegrityAutoHeal()

    await contextB.launch()
    await contextB.signIn()

    const note = await contextA.createSyncedNote()
    await contextB.sync()

    await contextA.changeNoteTitleAndSync(note, 'title-A')
    await contextB.changeNoteTitleAndSync(note, 'title-B')

    this.expectedItemCount += 2

    const noteAExpectedTimestamp = contextB.findNoteByTitle('title-A').payload.updated_at_timestamp
    const noteBExpectedTimestamp = contextB.findNoteByTitle('title-B').payload.updated_at_timestamp

    await contextA.sync()

    expect(contextA.findNoteByTitle('title-A').payload.updated_at_timestamp).to.equal(noteAExpectedTimestamp)
    expect(contextA.findNoteByTitle('title-B').payload.updated_at_timestamp).to.equal(noteBExpectedTimestamp)

    await this.sharedFinalAssertions()
    await contextB.deinit()
  }).timeout(20000)

  it('editing original note many times after conflict on other client should only result in 2 cumulative notes', async function () {
    const contextA = this.context
    const contextB = await Factory.createAppContextWithFakeCrypto('AppB', contextA.email, contextA.password)
    contextA.disableIntegrityAutoHeal()
    contextB.disableIntegrityAutoHeal()

    await contextB.launch()
    await contextB.signIn()

    const { original } = await contextA.createConflictedNotes(contextB)
    this.expectedItemCount += 2

    expect(contextA.noteCount).to.equal(2)
    expect(contextB.noteCount).to.equal(2)

    const allSyncs = []

    await contextA.changeNoteTitle(original, `${Math.random()}`)
    allSyncs.push(contextA.sync())
    allSyncs.push(contextB.sync())

    await Promise.all(allSyncs)

    expect(contextA.noteCount).to.equal(2)
    expect(contextB.noteCount).to.equal(2)

    await this.sharedFinalAssertions()
    await contextB.deinit()
  }).timeout(20000)
})
