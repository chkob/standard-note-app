export type CalendarActivityType = 'created' | 'edited'

export type CalendarActivity = {
  day: Date
  item: {
    title: string
    uuid: string
  }
}
