import type { AffineBlock, BlockConversionContext, DatabaseConversionWarning } from './types.ts'

import type { RecordValue } from './yjs.ts'
import * as Y from 'yjs'
import { escapeMarkdownText } from '../markdown.ts'
import { renderRichText } from '../richtext.ts'
import {

  BlockConversionError,

} from './types.ts'
import { decoded, mapValue, record } from './yjs.ts'

const SUPPORTED_COLUMN_TYPES: Record<string, true> = {
  'title': true,
  'rich-text': true,
  'number': true,
  'select': true,
  'multi-select': true,
}
const VIEW_SETTINGS: Record<string, true> = {
  id: true,
  name: true,
  mode: true,
  columns: true,
  filter: true,
  groupBy: true,
  header: true,
  groupProperties: true,
}

export interface ConvertedDatabase {
  readonly markdown: string
  readonly warnings: readonly DatabaseConversionWarning[]
}

interface SelectOption {
  readonly id: string
  readonly label: string
}

interface Column {
  readonly id: string
  readonly name: string
  readonly rowTitle?: boolean
  readonly type: string
  readonly options: readonly SelectOption[]
}

interface View {
  readonly id: string
  readonly name: string
  readonly mode: 'table' | 'kanban'
  readonly columns: readonly Column[]
  readonly groupBy?: Column
}

interface Row {
  readonly title: string
  readonly id: string
  readonly values: ReadonlyMap<string, string>
  readonly optionIds: ReadonlyMap<string, readonly string[]>
}

function requiredString(value: unknown, description: string, block: AffineBlock): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BlockConversionError(`AFFiNE database ${block.id} ${description} must be a non-empty string.`)
  }
  return value
}

function parseOptions(column: RecordValue, block: AffineBlock): readonly SelectOption[] {
  const id = requiredString(column.id, 'column ID', block)
  const data = column.data === undefined ? {} : record(column.data)
  if (data === undefined) {
    throw new BlockConversionError(`AFFiNE database ${block.id} column ${id} data must be an object.`)
  }
  const source = data.options ?? []
  if (!Array.isArray(source)) {
    throw new BlockConversionError(`AFFiNE database ${block.id} column ${id} options must be an array.`)
  }
  const seen = new Set<string>()
  return source.map((value, index) => {
    const option = record(value)
    if (option === undefined) {
      throw new BlockConversionError(`AFFiNE database ${block.id} column ${id} option ${index} must be an object.`)
    }
    const optionId = requiredString(option.id, `column ${id} option ID`, block)
    if (seen.has(optionId)) {
      throw new BlockConversionError(`AFFiNE database ${block.id} column ${id} repeats option ${optionId}.`)
    }
    seen.add(optionId)
    if (typeof option.value !== 'string') {
      throw new BlockConversionError(`AFFiNE database ${block.id} option ${optionId} label must be a string.`)
    }
    return { id: optionId, label: option.value }
  })
}

function parseColumns(block: AffineBlock): readonly Column[] {
  const source = decoded(block.source.get('prop:columns'))
  if (!Array.isArray(source) || source.length === 0) {
    throw new BlockConversionError(`AFFiNE database ${block.id} prop:columns must be a non-empty array.`)
  }
  const seen = new Set<string>()
  return source.map((value, index) => {
    const column = record(value)
    if (column === undefined) {
      throw new BlockConversionError(`AFFiNE database ${block.id} column ${index} must be an object.`)
    }
    const id = requiredString(column.id, `column ${index} ID`, block)
    if (seen.has(id)) {
      throw new BlockConversionError(`AFFiNE database ${block.id} repeats column ${id}.`)
    }
    seen.add(id)
    const type = requiredString(column.type, `column ${id} type`, block)
    if (SUPPORTED_COLUMN_TYPES[type] !== true) {
      throw new BlockConversionError(`Unsupported database column type "${type}" in block ${block.id}, column ${id}.`)
    }
    const name = column.name ?? (type === 'title' ? 'Title' : undefined)
    if (typeof name !== 'string' || name.length === 0) {
      throw new BlockConversionError(`AFFiNE database ${block.id} column ${id} name must be a non-empty string.`)
    }
    return {
      id,
      name,
      type,
      options: type === 'select' || type === 'multi-select' ? parseOptions(column, block) : [],
    }
  })
}

type WarnViewSetting = (setting: string, value: unknown, reason?: string) => void

function parseVisibleColumns(
  block: AffineBlock,
  view: RecordValue,
  viewId: string,
  columns: readonly Column[],
  byId: ReadonlyMap<string, Column>,
  warnViewSetting: WarnViewSetting,
): readonly Column[] {
  const sourceColumns = decoded(view.columns)
  if (!Array.isArray(sourceColumns)) {
    throw new BlockConversionError(`AFFiNE database ${block.id} view ${viewId} columns must be an array.`)
  }
  const visible: Column[] = []
  if (sourceColumns.length === 0) {
    visible.push(...columns)
  }
  for (const [columnIndex, columnValue] of sourceColumns.entries()) {
    const setting = record(columnValue)
    if (setting === undefined) {
      throw new BlockConversionError(`AFFiNE database ${block.id} view ${viewId} column ${columnIndex} must be an object.`)
    }
    const columnId = requiredString(setting.id, `view ${viewId} column ID`, block)
    const column = byId.get(columnId)
    if (column === undefined) {
      throw new BlockConversionError(`AFFiNE database ${block.id} view ${viewId} references unknown column ${columnId}.`)
    }
    if (setting.hide !== undefined && typeof setting.hide !== 'boolean') {
      throw new BlockConversionError(`AFFiNE database ${block.id} view ${viewId} column ${columnId} hide must be boolean.`)
    }
    if (setting.hide !== true) {
      visible.push(column)
    }
    for (const key of Object.keys(setting).sort()) {
      if (key !== 'id' && key !== 'hide') {
        warnViewSetting(`columns[${columnIndex}].${key}`, decoded(setting[key]))
      }
    }
  }
  if (visible.length === 0) {
    throw new BlockConversionError(`AFFiNE database ${block.id} view ${viewId} has no visible columns.`)
  }
  return visible
}

function parseViewFilter(
  block: AffineBlock,
  context: BlockConversionContext,
  view: RecordValue,
  viewId: string,
  warnings: DatabaseConversionWarning[],
): void {
  if (view.filter === undefined) {
    return
  }
  const filter = record(view.filter)
  if (filter === undefined) {
    throw new BlockConversionError(`AFFiNE database ${block.id} view ${viewId} filter must be an object.`)
  }
  if (filter.type !== 'group' || !Array.isArray(filter.conditions) || filter.conditions.length > 0) {
    warnings.push({
      kind: 'database-view-filter',
      documentId: context.documentId,
      blockId: block.id,
      viewId,
      setting: 'filter',
      value: filter,
      reason: 'Markdown tables include all rows; AFFiNE view filters are not applied.',
    })
  }
}

function parseViewHeader(
  block: AffineBlock,
  view: RecordValue,
  viewId: string,
  byId: ReadonlyMap<string, Column>,
  warnViewSetting: WarnViewSetting,
): void {
  if (view.header === undefined) {
    return
  }
  const header = record(view.header)
  if (header === undefined) {
    throw new BlockConversionError(`AFFiNE database ${block.id} view ${viewId} header must be an object.`)
  }
  if (header.titleColumn !== undefined) {
    const titleColumn = byId.get(requiredString(header.titleColumn, `view ${viewId} title column`, block))
    if (titleColumn?.type !== 'title') {
      throw new BlockConversionError(`AFFiNE database ${block.id} view ${viewId} titleColumn must reference a title column.`)
    }
  }
  for (const key of Object.keys(header).sort()) {
    if (key !== 'titleColumn') {
      warnViewSetting(`header.${key}`, decoded(header[key]))
    }
  }
}

function parseViewGroupBy(
  block: AffineBlock,
  view: RecordValue,
  viewId: string,
  mode: View['mode'],
  byId: ReadonlyMap<string, Column>,
  warnViewSetting: WarnViewSetting,
): Column | undefined {
  if (mode === 'table') {
    if (view.groupBy !== undefined) {
      warnViewSetting(
        'groupBy',
        decoded(view.groupBy),
        'AFFiNE table grouping is not representable; the Markdown table includes all rows without grouping.',
      )
    }
    return undefined
  }
  const grouping = record(view.groupBy)
  if (grouping === undefined) {
    throw new BlockConversionError(`AFFiNE database ${block.id} kanban view ${viewId} requires groupBy metadata.`)
  }
  const columnId = requiredString(grouping.columnId, `kanban view ${viewId} groupBy column`, block)
  const groupBy = byId.get(columnId)
  if (groupBy?.type !== 'select' && groupBy?.type !== 'multi-select') {
    throw new BlockConversionError(`AFFiNE database ${block.id} kanban view ${viewId} groupBy must reference a select or multi-select column.`)
  }
  return groupBy
}

function parseViews(
  block: AffineBlock,
  context: BlockConversionContext,
  columns: readonly Column[],
  warnings: DatabaseConversionWarning[],
): readonly View[] {
  const source = decoded(block.source.get('prop:views'))
  if (!Array.isArray(source) || source.length === 0) {
    throw new BlockConversionError(`AFFiNE database ${block.id} prop:views must be a non-empty array.`)
  }
  const byId = new Map(columns.map(column => [column.id, column]))
  const seen = new Set<string>()

  return source.map((value, index) => {
    const view = record(value)
    if (view === undefined) {
      throw new BlockConversionError(`AFFiNE database ${block.id} view ${index} must be an object.`)
    }
    const id = requiredString(view.id, `view ${index} ID`, block)
    if (seen.has(id)) {
      throw new BlockConversionError(`AFFiNE database ${block.id} repeats view ${id}.`)
    }
    seen.add(id)
    const name = requiredString(view.name, `view ${id} name`, block)
    if (view.mode !== 'table' && view.mode !== 'kanban') {
      throw new BlockConversionError(`AFFiNE database ${block.id} view ${id} has unsupported mode "${String(view.mode)}".`)
    }
    const mode = view.mode
    const warnViewSetting: WarnViewSetting = (setting, value, reason = 'AFFiNE view setting is not representable in a Markdown table.') => {
      warnings.push({
        kind: 'database-view-setting',
        documentId: context.documentId,
        blockId: block.id,
        viewId: id,
        setting,
        value,
        reason,
      })
    }
    const visible = parseVisibleColumns(block, view, id, columns, byId, warnViewSetting)
    parseViewFilter(block, context, view, id, warnings)
    parseViewHeader(block, view, id, byId, warnViewSetting)
    const groupBy = parseViewGroupBy(block, view, id, mode, byId, warnViewSetting)

    if (view.groupProperties !== undefined) {
      const groupProperties = decoded(view.groupProperties)
      if (!Array.isArray(groupProperties)) {
        throw new BlockConversionError(`AFFiNE database ${block.id} view ${id} groupProperties must be an array.`)
      }
      if (groupProperties.length > 0) {
        warnViewSetting('groupProperties', groupProperties)
      }
    }
    for (const setting of Object.keys(view).sort()) {
      if (VIEW_SETTINGS[setting] !== true) {
        warnViewSetting(setting, decoded(view[setting]))
      }
    }
    return groupBy === undefined ? { id, name, mode, columns: visible } : { id, name, mode, columns: visible, groupBy }
  })
}

function optionLabel(column: Column, id: string, block: AffineBlock): string {
  const option = column.options.find(candidate => candidate.id === id)
  if (option === undefined) {
    throw new BlockConversionError(`AFFiNE database ${block.id} column ${column.id} references unknown ${column.type} option ${id}.`)
  }
  return option.label
}

function cellText(
  value: unknown,
  column: Column,
  block: AffineBlock,
  context: BlockConversionContext,
): string {
  if (value === undefined || value === null || value === '') {
    return ''
  }
  switch (column.type) {
    case 'rich-text': {
      if (value instanceof Y.Text) {
        const rendered = renderRichText(value, context.pages, context.coverage)
        context.losses.push(...rendered.losses)
        return rendered.markdown
      }
      if (typeof value !== 'string') {
        throw new BlockConversionError(`AFFiNE database ${block.id} column ${column.id} value must be rich text.`)
      }
      return escapeMarkdownText(value)
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new BlockConversionError(`AFFiNE database ${block.id} column ${column.id} value must be a finite number.`)
      }
      return String(value)
    case 'select':
      if (typeof value !== 'string') {
        throw new BlockConversionError(`AFFiNE database ${block.id} column ${column.id} value must be a select option ID.`)
      }
      return optionLabel(column, value, block)
    case 'multi-select': {
      const values = decoded(value)
      if (!Array.isArray(values) || values.some(item => typeof item !== 'string')) {
        throw new BlockConversionError(`AFFiNE database ${block.id} column ${column.id} value must be an array of option IDs.`)
      }
      return values.map(id => optionLabel(column, id as string, block)).join(', ')
    }
    default:
      throw new BlockConversionError(`AFFiNE database ${block.id} column ${column.id} cannot contain a title cell value.`)
  }
}

function parseRows(
  block: AffineBlock,
  context: BlockConversionContext,
  columns: readonly Column[],
): readonly Row[] {
  const rowIds = new Set(block.children)
  if (rowIds.size !== block.children.length) {
    throw new BlockConversionError(`AFFiNE database ${block.id} repeats a child row ID.`)
  }
  const cellsValue = block.source.get('prop:cells')
  const cells = cellsValue === undefined ? {} : record(cellsValue)
  if (cells === undefined) {
    throw new BlockConversionError(`AFFiNE database ${block.id} prop:cells must be an object.`)
  }
  for (const rowId of Object.keys(cells)) {
    if (!rowIds.has(rowId)) {
      throw new BlockConversionError(`AFFiNE database ${block.id} cells reference unknown row ${rowId}.`)
    }
  }

  return block.children.map((rowId) => {
    const child = context.blocks.get(rowId)
    if (child === undefined) {
      throw new BlockConversionError(`Missing database row ${rowId} referenced by block ${block.id}.`)
    }
    if (child.flavour !== 'affine:paragraph' || mapValue(child.source, 'prop:type') !== 'text') {
      throw new BlockConversionError(`AFFiNE database row ${rowId} must be a text paragraph.`)
    }
    if (child.children.length > 0) {
      throw new BlockConversionError(`AFFiNE database row ${rowId} cannot have children.`)
    }
    const title = mapValue(child.source, 'prop:text')
    if (!(title instanceof Y.Text)) {
      throw new BlockConversionError(`AFFiNE database row ${rowId} prop:text must be Y.Text.`)
    }
    const renderedTitle = renderRichText(title, context.pages, context.coverage)
    context.losses.push(...renderedTitle.losses)
    const rowCellsValue = cells[rowId]
    const rowCells = rowCellsValue === undefined ? {} : record(rowCellsValue)
    if (rowCells === undefined) {
      throw new BlockConversionError(`AFFiNE database row ${rowId} cells must be an object.`)
    }
    const byId = new Map(columns.map(column => [column.id, column]))
    for (const columnId of Object.keys(rowCells)) {
      if (!byId.has(columnId)) {
        throw new BlockConversionError(`AFFiNE database row ${rowId} references unknown column ${columnId}.`)
      }
    }

    const sourceRowCells = cellsValue instanceof Y.Map ? mapValue(cellsValue, rowId) : undefined

    const values = new Map<string, string>()
    const optionIds = new Map<string, readonly string[]>()
    for (const column of columns) {
      if (column.type === 'title') {
        values.set(column.id, renderedTitle.markdown)
        continue
      }
      const cell = record(rowCells[column.id])
      if (rowCells[column.id] !== undefined && cell === undefined) {
        throw new BlockConversionError(`AFFiNE database row ${rowId} column ${column.id} cell must be an object.`)
      }
      if (cell !== undefined && cell.columnId !== column.id) {
        throw new BlockConversionError(`AFFiNE database row ${rowId} cell ${column.id} has mismatched columnId.`)
      }
      const sourceCell = sourceRowCells instanceof Y.Map ? mapValue(sourceRowCells, column.id) : undefined
      const sourceValue = sourceCell instanceof Y.Map ? mapValue(sourceCell, 'value') : cell?.value
      values.set(column.id, cellText(sourceValue, column, block, context))
      if (column.type === 'select' || column.type === 'multi-select') {
        const value = decoded(sourceValue)
        optionIds.set(column.id, value === undefined || value === null || value === ''
          ? []
          : Array.isArray(value) ? value as string[] : [value as string])
      }
    }
    return { id: rowId, title: renderedTitle.markdown, values, optionIds }
  })
}

function heading(value: string): string {
  return escapeMarkdownText(value.replace(/\r\n?|\n/gu, ' '))
}

function tableCell(value: string): string {
  return escapeMarkdownText(value).replace(/\r\n?|\n/gu, '<br>')
}

const ROW_TITLE_COLUMN: Column = { id: 'row-title', name: 'Title', type: 'title', options: [], rowTitle: true }

function markdownTable(view: View, rows: readonly Row[]): string {
  const lines = [
    `| ${view.columns.map(column => tableCell(column.name)).join(' | ')} |`,
    `| ${view.columns.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) {
    const values = view.columns.map((column) => {
      const value = column.rowTitle === true ? row.title : row.values.get(column.id) ?? ''
      if (column.rowTitle === true || column.type === 'title' || column.type === 'rich-text') {
        return value.replace(/(?<!\\)\|/gu, '\\|').replace(/\r\n?|\n/gu, '<br>')
      }
      if (column.type === 'number') {
        return value
      }
      return tableCell(value)
    })
    lines.push(`| ${values.join(' | ')} |`)
  }
  return lines.join('\n')
}

function groupedRows(view: View, rows: readonly Row[]): Array<[string, readonly Row[]]> {
  const column = view.groupBy
  if (column === undefined) {
    return [['', rows]]
  }
  const groups = new Map<string, Row[]>()
  const ungrouped: Row[] = []
  for (const row of rows) {
    const ids = row.optionIds.get(column.id) ?? []
    if (ids.length === 0) {
      ungrouped.push(row)
    }
    for (const id of ids) {
      const group = groups.get(id) ?? []
      group.push(row)
      groups.set(id, group)
    }
  }
  const result: Array<[string, readonly Row[]]> = []
  for (const option of column.options) {
    result.push([option.label, groups.get(option.id) ?? []])
  }
  if (ungrouped.length > 0) {
    result.push(['Ungrouped', ungrouped])
  }
  return result
}

/** Convert one AFFiNE database, including each table or kanban view, to Markdown tables. */
export function convertDatabaseBlock(
  block: AffineBlock,
  context: BlockConversionContext,
): ConvertedDatabase {
  if (block.flavour !== 'affine:database') {
    throw new BlockConversionError(`AFFiNE block ${block.id} is not a database.`)
  }
  const columns = parseColumns(block)
  const warnings: DatabaseConversionWarning[] = []
  const views = parseViews(block, context, columns, warnings)
  const rows = parseRows(block, context, columns)
  const sections: string[] = []
  const title = block.source.get('prop:title') ?? ''
  if (title instanceof Y.Text) {
    const renderedTitle = renderRichText(title, context.pages, context.coverage)
    context.losses.push(...renderedTitle.losses)
    if (renderedTitle.markdown.length > 0) {
      sections.push(`### ${renderedTitle.markdown.replace(/\r\n?|\n/gu, ' ')}`)
    }
  }
  else {
    if (typeof title !== 'string') {
      throw new BlockConversionError(`AFFiNE database ${block.id} prop:title must be a string or Y.Text.`)
    }
    if (title.length > 0) {
      sections.push(`### ${heading(title)}`)
    }
  }

  for (const view of views) {
    const viewSections = [`#### ${heading(view.name)}`]
    if (view.mode === 'table') {
      viewSections.push(markdownTable(view, rows))
    }
    else {
      for (const [group, grouped] of groupedRows(view, rows)) {
        viewSections.push(`##### ${heading(group)}`, markdownTable(view, grouped))
      }
    }
    sections.push(viewSections.join('\n\n'))
  }
  const hiddenColumns = columns.filter(column =>
    views.every(view => !view.columns.some(visible => visible.id === column.id)),
  )
  const needsRowTitles = !columns.some(column => column.type === 'title')
  if (needsRowTitles || hiddenColumns.length > 0) {
    const allDataView: View = {
      id: 'all-data',
      name: 'All data',
      mode: 'table',
      columns: [...needsRowTitles ? [ROW_TITLE_COLUMN] : [], ...hiddenColumns],
    }
    sections.push(`#### All data\n\n${markdownTable(allDataView, rows)}`)
  }
  return { markdown: sections.join('\n\n'), warnings }
}
