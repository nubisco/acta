/** Shared shapes for the label settings pane and its editor dialog. */

export interface ILabelView {
  id: string
  name: string
  color: string
}

export interface ILabelGroupView {
  name: string
  space: string | null
  labels: ILabelView[]
}

/**
 * The palette a label can take. These are the names the API stores, not CSS
 * colours, so the list is deliberately the server's vocabulary rather than
 * the design system's full ramp.
 */
export const LABEL_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'lime',
  'blue',
  'sky',
  'purple',
  'pink',
  'black',
] as const

export const LABEL_COLOR_OPTIONS = LABEL_COLORS.map((c) => ({
  label: c,
  value: c,
}))
