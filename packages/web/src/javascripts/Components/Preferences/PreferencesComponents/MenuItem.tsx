import Icon from '@/Components/Icon/Icon'
import { FunctionComponent } from 'react'
import { IconType } from '@standardnotes/snjs'
import { ErrorCircle } from '@/Components/UIElements/ErrorCircle'

interface Props {
  iconType: IconType
  label: string
  selected: boolean
  hasBubble?: boolean
  onClick: () => void
}

const PreferencesMenuItem: FunctionComponent<Props> = ({ iconType, label, selected, onClick, hasBubble }) => (
  <div
    className={`preferences-menu-item box-border flex h-auto w-auto min-w-42 cursor-pointer select-none flex-row items-center justify-start rounded border border-solid px-4 py-2 text-sm hover:border-border hover:bg-default ${
      selected ? 'selected border-info font-bold text-info' : 'border-transparent'
    }`}
    onClick={(e) => {
      e.preventDefault()
      onClick()
    }}
  >
    <Icon className={`icon text-base ${selected ? 'text-info' : 'text-neutral'}`} type={iconType} />
    <div className="min-w-1" />
    {label}
    {hasBubble && (
      <span className="ml-2">
        <ErrorCircle />
      </span>
    )}
  </div>
)

export default PreferencesMenuItem
