import { computed, nextTick, ref, watch, type Ref } from "vue";
import type { Row } from "../api";
import {
  choiceLabel,
  pointChoices,
  pointIsString,
  communicationFields,
  communicationRecommendation,
  type PointTableData,
} from "../domain/pointTables";
import {
  displayCell,
  fieldForColumn,
  parseCell,
  parseClipboard,
  serializeClipboard,
} from "../domain/pointGrid";
import type { TableColumn } from "../domain/tableColumns";

type Cell = { id: number; column: string };
type Draft = Record<number, Row>;
type Options = {
  data: Ref<PointTableData | null>;
  scoped: Ref<PointTableData | null>;
  rows: Ref<Row[]>;
  columns: Ref<TableColumn[]>;
  page: Ref<number>;
  pageSize?: Ref<number>;
  writable: () => boolean;
  rowWritable?: (row: Row, values: Row) => boolean;
  allowedChoice?: (row: Row, field: string, choice: Row, values: Row) => boolean;
  blocked: () => boolean;
  locked: (key: string) => boolean;
  error: (message: string) => void;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const clipboardType = "application/x-protocol-point-cells";

export function usePointGrid(options: Options) {
  const table = ref<HTMLElement>();
  const active = ref<Cell | null>(null),
    anchor = ref<Cell | null>(null);
  const editor = ref<Cell | null>(null),
    input = ref("");
  const selectedRowIds = ref<number[]>([]);
  const rowAnchor = ref<number | null>(null);
  const draft = ref<Draft>({});
  const undoStack = ref<Draft[]>([]),
    redoStack = ref<Draft[]>([]);
  const changedRows = computed(() => Object.keys(draft.value).length);
  const changedCells = computed(() =>
    Object.values(draft.value).reduce(
      (n, row) => n + Object.keys(row).length,
      0,
    ),
  );
  const hasHistory = computed(
    () => undoStack.value.length > 0 || redoStack.value.length > 0,
  );
  const rowById = (id: number) =>
    options.data.value?.rows.find((row) => row.id === id);
  function initial(row: Row): Row {
    const data = options.data.value!;
    return Object.fromEntries(
      data.definition.editor.map((key) => {
        const field = data.definition.fields[key];
        return [
          key,
          Object.hasOwn(row.edit_values, key)
            ? row.edit_values[key]
            : (field.default ??
              (field.nullable || field.reference || field.type === "number"
                ? null
                : field.type === "boolean"
                  ? false
                  : "")),
        ];
      }),
    );
  }
  // Read-only parent references still constrain editable child choices.
  const values = (row: Row) => ({
    ...row.edit_values,
    ...initial(row),
    ...draft.value[row.id],
  });
  const field = (column: string) =>
    options.data.value && fieldForColumn(options.data.value, column);
  function editable(row: Row, column: string) {
    const key = field(column);
    return (
      !!key &&
      options.writable() &&
      (options.rowWritable?.(row, values(row)) ?? true) &&
      !options.blocked() &&
      !options.locked(key) &&
      !(
        ["min_value", "max_value"].includes(key) &&
        pointIsString(options.data.value!, values(row), row)
      )
    );
  }
  function text(row: Row, column: string) {
    return displayCell(options.data.value!, row, column, values(row));
  }
  function raw(row: Row, column: string) {
    const key = field(column);
    return key ? String(values(row)[key] ?? "") : "";
  }
  const editorDirty = computed(() => {
    const row = editor.value && rowById(editor.value.id);
    return !!row && input.value !== raw(row, editor.value!.column);
  });
  const dirty = computed(() => changedRows.value > 0 || editorDirty.value);
  function reset() {
    draft.value = {};
    undoStack.value = [];
    redoStack.value = [];
    editor.value = null;
    active.value = null;
    anchor.value = null;
    selectedRowIds.value = [];
    rowAnchor.value = null;
  }
  watch(options.data, reset);
  function coordinates(cell: Cell | null) {
    return (
      cell && {
        row: options.rows.value.findIndex((row) => row.id === cell.id),
        column: options.columns.value.findIndex(
          (column) => column.key === cell.column,
        ),
      }
    );
  }
  const selection = computed(() => {
    const a = coordinates(anchor.value),
      b = coordinates(active.value);
    return a && b && a.row >= 0 && a.column >= 0 && b.row >= 0 && b.column >= 0
      ? {
          firstRow: Math.min(a.row, b.row),
          lastRow: Math.max(a.row, b.row),
          firstColumn: Math.min(a.column, b.column),
          lastColumn: Math.max(a.column, b.column),
        }
      : null;
  });
  const isRowSelected = (id: number) => selectedRowIds.value.includes(id);
  function clearSelection() {
    selectedRowIds.value = [];
    rowAnchor.value = null;
    active.value = null;
    anchor.value = null;
  }
  function applyRowSelection(ids: Set<number>) {
    if (ids.size > 200) {
      options.error("一次最多选择 200 行，请分批复制。");
      return false;
    }
    if (!finish()) return false;
    selectedRowIds.value = options.rows.value
      .filter((row) => ids.has(row.id))
      .map((row) => row.id);
    active.value = null;
    anchor.value = null;
    return true;
  }
  function selectRow(row: Row, extend = false) {
    if (options.blocked()) return false;
    const index = options.rows.value.findIndex((item) => item.id === row.id);
    if (index < 0) return false;
    const ids = new Set(selectedRowIds.value);
    const start = options.rows.value.findIndex(
      (item) => item.id === rowAnchor.value,
    );
    if (extend && start >= 0) {
      for (const item of options.rows.value.slice(
        Math.min(start, index),
        Math.max(start, index) + 1,
      ))
        ids.add(item.id);
    } else if (ids.has(row.id)) ids.delete(row.id);
    else ids.add(row.id);
    if (!applyRowSelection(ids)) return false;
    if (!extend || rowAnchor.value == null) rowAnchor.value = row.id;
    return true;
  }
  function selectPage(rows: Row[]) {
    if (options.blocked()) return false;
    const visible = new Set(options.rows.value.map((row) => row.id));
    const pageIds = rows.map((row) => row.id).filter((id) => visible.has(id));
    if (!pageIds.length) return false;
    const ids = new Set(selectedRowIds.value);
    const remove = pageIds.every((id) => ids.has(id));
    for (const id of pageIds) remove ? ids.delete(id) : ids.add(id);
    if (!applyRowSelection(ids)) return false;
    rowAnchor.value = pageIds[0];
    return true;
  }
  function selected(id: number, column: string) {
    if (isRowSelected(id)) return true;
    const position = coordinates({ id, column }),
      range = selection.value;
    return (
      !!position &&
      !!range &&
      position.row >= range.firstRow &&
      position.row <= range.lastRow &&
      position.column >= range.firstColumn &&
      position.column <= range.lastColumn
    );
  }
  const isActive = (id: number, column: string) =>
    active.value?.id === id && active.value.column === column;
  const isEditing = (id: number, column: string) =>
    editor.value?.id === id && editor.value.column === column;
  function modified(row: Row, column: string) {
    const key = field(column);
    return !!key && Object.hasOwn(draft.value[row.id] || {}, key);
  }
  async function focusActive() {
    await nextTick();
    const cell =
      active.value &&
      table.value?.querySelector<HTMLElement>(
        `tr[data-row-id="${active.value.id}"] td[data-column-key="${active.value.column}"]`,
      );
    cell?.focus({ preventScroll: true });
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function choose(row: Row, column: string, extend = false) {
    if (options.blocked()) return;
    if (isEditing(row.id, column)) return;
    if (!finish()) return;
    selectedRowIds.value = [];
    rowAnchor.value = null;
    active.value = { id: row.id, column };
    if (!extend || !anchor.value) anchor.value = { ...active.value };
    void focusActive();
  }
  async function start(row: Row, column: string, replace?: string) {
    if (!editable(row, column)) return;
    if (!isActive(row.id, column)) choose(row, column);
    if (!isActive(row.id, column)) return;
    editor.value = { id: row.id, column };
    input.value = replace ?? raw(row, column);
    options.error("");
    await nextTick();
    const element = table.value?.querySelector<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >(".point-cell-editor");
    element?.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (replace === undefined) element.select();
      else
        element.setSelectionRange(element.value.length, element.value.length);
    }
  }
  function reconcile(next: Row, data: PointTableData) {
    for (let pass = 0; pass < 2; pass++)
      for (const key of data.definition.editor)
        if (
          data.definition.fields[key].reference &&
          next[key] != null &&
          !pointChoices(data, key, next).some(
            (choice) => choice.id === next[key],
          )
        )
          next[key] = null;
    return next;
  }
  function setDraft(rows: Map<number, Row>) {
    const next = clone(draft.value);
    for (const [id, values] of rows) {
      if (options.rowWritable && !options.rowWritable(rowById(id)!, values))
        throw new Error("此记录或目标协议不在你的编辑范围内，未应用修改。请联系管理员分配对应板卡和协议权限。");
      const before = initial(rowById(id)!);
      const patch = Object.fromEntries(
        Object.entries(values).filter(
          ([key, value]) =>
            options.data.value!.definition.editor.includes(key) &&
            !equal(value, before[key]),
        ),
      );
      if (Object.keys(patch).length) next[id] = patch;
      else delete next[id];
    }
    if (Object.keys(next).length > 200)
      throw new Error("一次最多修改 200 行，请先保存当前修改。");
    if (equal(next, draft.value)) return;
    undoStack.value = [...undoStack.value.slice(-99), clone(draft.value)];
    redoStack.value = [];
    draft.value = next;
    options.error("");
  }
  function finish() {
    if (!editor.value) return true;
    if (!editorDirty.value) {
      editor.value = null;
      return true;
    }
    const row = rowById(editor.value.id),
      key = field(editor.value.column);
    if (!row || !key || !options.scoped.value) return false;
    try {
      const next = values(row);
      if (options.data.value!.definition.fields[key].reference) {
        // Native selects supply stable IDs, not text labels that may look like IDs.
        const id = Number(input.value);
        if (
          !input.value ||
          !Number.isSafeInteger(id) ||
          !pointChoices(options.scoped.value, key, next).some(
            (choice) => choice.id === id,
          )
        )
          throw new Error("请选择有效的关联记录。");
        next[key] = id;
      } else
        next[key] = parseCell(options.scoped.value, key, input.value, next);
      if (options.data.value!.definition.fields[key].reference)
        reconcile(next, options.scoped.value);
      if (key === "internal_type")
        clearStringBounds(next, row);
      setDraft(new Map([[row.id, next]]));
      editor.value = null;
      return true;
    } catch (error) {
      options.error((error as Error).message);
      return false;
    }
  }
  function applyRecommendation(row: Row) {
    if (!finish() || !options.data.value || options.blocked() || !options.writable()) return false;
    const data = options.data.value;
    const suggestion = communicationRecommendation(data, values(row), row);
    if (!suggestion || communicationFields.some(key => {
      const column = Object.keys(data.definition.inline).find(column => data.definition.inline[column] === key);
      return !column || !editable(row, column);
    })) return false;
    try {
      setDraft(new Map([[row.id, { ...values(row), ...suggestion }]]));
      return true;
    } catch (error) {
      options.error((error as Error).message);
      return false;
    }
  }
  function clearStringBounds(next: Row, row: Row) {
    if (
      options.data.value!.kind !== "process" ||
      !pointIsString(options.data.value!, next, row)
    )
      return;
    for (const key of ["min_value", "max_value"])
      if (options.data.value!.definition.editor.includes(key)) next[key] = null;
  }
  function cancelEditor() {
    editor.value = null;
    options.error("");
    void focusActive();
  }
  function travel(dr: number, dc: number, extend = false, wrap = false) {
    if (!finish()) return;
    const position = coordinates(active.value);
    if (!position || !options.columns.value.length) return;
    let row = position.row + dr,
      column = position.column + dc;
    if (wrap) {
      if (column >= options.columns.value.length) {
        row++;
        column = 0;
      }
      if (column < 0) {
        row--;
        column = options.columns.value.length - 1;
      }
    }
    if (
      row < 0 ||
      row >= options.rows.value.length ||
      column < 0 ||
      column >= options.columns.value.length
    ) {
      void focusActive();
      return;
    }
    active.value = {
      id: options.rows.value[row].id,
      column: options.columns.value[column].key,
    };
    if (!extend) anchor.value = { ...active.value };
    options.page.value = Math.floor(row / (options.pageSize?.value ?? 50)) + 1;
    void focusActive();
  }
  function undo() {
    if (options.blocked() || !finish() || !undoStack.value.length) return;
    redoStack.value.push(clone(draft.value));
    draft.value = undoStack.value.pop()!;
    options.error("");
  }
  function redo() {
    if (options.blocked() || !finish() || !redoStack.value.length) return;
    undoStack.value.push(clone(draft.value));
    draft.value = redoStack.value.pop()!;
    options.error("");
  }
  function editorKey(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditor();
    } else if (event.key === "Enter") {
      if (event.shiftKey && event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      travel(event.shiftKey ? -1 : 1, 0);
    } else if (event.key === "Tab") {
      event.preventDefault();
      travel(0, event.shiftKey ? -1 : 1, false, true);
    }
  }
  function keydown(event: KeyboardEvent, row: Row, column: string) {
    if (options.blocked() || event.isComposing || event.keyCode === 229) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c" &&
      selectedRowIds.value.length
    )
      return;
    if (!isActive(row.id, column)) choose(row, column);
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      }
      if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (moves[event.key]) {
      event.preventDefault();
      travel(...moves[event.key], event.shiftKey);
    } else if (event.key === "Tab") {
      event.preventDefault();
      travel(0, event.shiftKey ? -1 : 1, false, true);
    } else if (["Enter", "F2"].includes(event.key)) {
      event.preventDefault();
      void start(row, column);
    } else if (event.key === "Escape") {
      anchor.value = active.value && { ...active.value };
    } else if (
      event.key.length === 1 &&
      !event.altKey &&
      editable(row, column)
    ) {
      event.preventDefault();
      void start(row, column, event.key);
    } else if (
      ["Delete", "Backspace"].includes(event.key) &&
      editable(row, column)
    ) {
      event.preventDefault();
      void start(row, column, "");
    }
  }
  type ClipboardPayload = { plain: string; internal: string };
  let pendingCopy: ClipboardPayload | null = null;
  function clipboardPayload(
    rows: Row[],
    columns: TableColumn[],
  ): ClipboardPayload {
    if (!rows.length || !columns.length)
      throw new Error("请先选择需要复制的单元格或行。");
    if (rows.length > 200) throw new Error("一次最多复制 200 行，请分批复制。");
    const matrix = rows.map((row) =>
      columns.map((column) => {
        const key = field(column.key);
        if (key && options.data.value!.definition.fields[key].reference) {
          const choice = pointChoices(
            options.scoped.value!,
            key,
            values(row),
          ).find((choice) => choice.id === values(row)[key]);
          if (choice) return choiceLabel(choice);
        }
        return text(row, column.key);
      }),
    );
    return {
      plain: serializeClipboard(matrix),
      // Preserve null inheritance and stable references when copying within this app.
      internal: JSON.stringify({
        version: 1,
        columns: columns.map((column) => field(column.key) || null),
        values: rows.map((row) =>
          columns.map((column) => {
            const key = field(column.key);
            return key ? values(row)[key] : null;
          }),
        ),
      }),
    };
  }
  function rowsPayload(row?: Row) {
    const ids = row ? new Set([row.id]) : new Set(selectedRowIds.value);
    return clipboardPayload(
      options.rows.value.filter((item) => ids.has(item.id)),
      options.columns.value,
    );
  }
  function selectionPayload() {
    if (selectedRowIds.value.length) return rowsPayload();
    const range = selection.value;
    if (!range) throw new Error("请先选择需要复制的单元格或行。");
    return clipboardPayload(
      options.rows.value.slice(range.firstRow, range.lastRow + 1),
      options.columns.value.slice(range.firstColumn, range.lastColumn + 1),
    );
  }
  function copy(event: ClipboardEvent) {
    if (
      !event.clipboardData ||
      (!pendingCopy &&
        (editor.value || (!selection.value && !selectedRowIds.value.length)))
    )
      return false;
    try {
      const payload = pendingCopy || selectionPayload();
      event.clipboardData.setData("text/plain", payload.plain);
      event.clipboardData.setData(clipboardType, payload.internal);
      event.preventDefault();
      return true;
    } catch (error) {
      if (!pendingCopy) options.error((error as Error).message);
      return false;
    }
  }
  function copyWithEvent(payload: ClipboardPayload) {
    let copied = false;
    const listener = (event: ClipboardEvent) => {
      copied = copy(event);
      if (copied) event.stopImmediatePropagation();
    };
    pendingCopy = payload;
    document.addEventListener("copy", listener, true);
    try {
      const result = document.execCommand("copy");
      return result && copied;
    } catch {
      return false;
    } finally {
      pendingCopy = null;
      document.removeEventListener("copy", listener, true);
    }
  }
  function copyWithTextarea(payload: ClipboardPayload) {
    // Moving focus would trigger the cell's blur handler. Preserve an open editor.
    if (editor.value) return false;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const inputSelection =
      previous instanceof HTMLInputElement ||
      previous instanceof HTMLTextAreaElement
        ? {
            start: previous.selectionStart,
            end: previous.selectionEnd,
            direction: previous.selectionDirection,
          }
        : null;
    const selection = document.getSelection();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, index) =>
          selection.getRangeAt(index).cloneRange(),
        )
      : [];
    const textarea = document.createElement("textarea");
    textarea.value = payload.plain;
    textarea.readOnly = true;
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
    document.body.appendChild(textarea);
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      return copyWithEvent(payload);
    } finally {
      textarea.remove();
      if (previous?.isConnected) {
        previous.focus({ preventScroll: true });
        if (
          inputSelection &&
          inputSelection.start != null &&
          inputSelection.end != null
        )
          (
            previous as HTMLInputElement | HTMLTextAreaElement
          ).setSelectionRange(
            inputSelection.start,
            inputSelection.end,
            inputSelection.direction || undefined,
          );
      }
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }
  async function writeClipboard(payload: ClipboardPayload) {
    // Native copy exposes the same typed payload to paste events as Ctrl+C.
    if (copyWithEvent(payload)) return true;
    // Custom async formats are a fallback for browsers without execCommand.
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      try {
        const format = `web ${clipboardType}`;
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([payload.plain], { type: "text/plain" }),
            [format]: new Blob([payload.internal], { type: clipboardType }),
          }),
        ]);
        return true;
      } catch {
        /* Try the native copy event when custom web formats are unsupported. */
      }
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(payload.plain);
        return true;
      } catch {
        /* Older browsers may still support copying a selected textarea. */
      }
    }
    if (copyWithTextarea(payload)) return true;
    throw new Error(
      "复制失败：浏览器未允许写入剪贴板，请完成单元格编辑后用 Ctrl+C 复制，或检查剪贴板权限。",
    );
  }
  async function copyRows(row?: Row): Promise<boolean> {
    try {
      return await writeClipboard(rowsPayload(row));
    } catch (error) {
      options.error((error as Error).message);
      return false;
    }
  }
  async function copySelection(): Promise<boolean> {
    try {
      return await writeClipboard(selectionPayload());
    } catch (error) {
      options.error((error as Error).message);
      return false;
    }
  }
  function paste(event: ClipboardEvent) {
    if (
      editor.value ||
      options.blocked() ||
      !options.writable() ||
      !active.value ||
      !event.clipboardData
    )
      return;
    event.preventDefault();
    try {
      const matrix = parseClipboard(event.clipboardData.getData("text/plain"));
      if (!matrix.length) return;
      const start = coordinates(active.value)!;
      const width = matrix[0].length;
      let internal: { columns: string[]; values: unknown[][] } | null = null;
      const encoded =
        event.clipboardData.getData(clipboardType) ||
        event.clipboardData.getData(`web ${clipboardType}`);
      if (encoded && encoded.length <= 2 * 1024 * 1024) {
        const candidate = JSON.parse(encoded);
        if (
          candidate.version === 1 &&
          Array.isArray(candidate.columns) &&
          candidate.columns.length === width &&
          candidate.columns.every(
            (key: unknown, i: number) =>
              key === field(options.columns.value[start.column + i]?.key || ""),
          ) &&
          Array.isArray(candidate.values) &&
          candidate.values.length === matrix.length &&
          candidate.values.every(
            (row: unknown) =>
              Array.isArray(row) &&
              row.length === width &&
              row.every(
                (value) =>
                  value === null ||
                  ["string", "number", "boolean"].includes(typeof value),
              ),
          )
        )
          internal = candidate;
      }
      if (matrix.some((row) => row.length !== width))
        throw new Error("粘贴内容每行的列数必须相同。");
      if (
        start.row < 0 ||
        start.column < 0 ||
        start.row + matrix.length > options.rows.value.length ||
        start.column + width > options.columns.value.length
      )
        throw new Error("粘贴区域超出当前表格，请调整起始单元格或粘贴范围。");
      const changes = new Map<number, Row>();
      matrix.forEach((cells, index) => {
        const row = options.rows.value[start.row + index],
          next = values(row);
        const updates = cells.map((value, offset) => {
          const column = options.columns.value[start.column + offset].key;
          if (!editable(row, column))
            throw new Error(
              `第 ${start.row + index + 1} 行「${options.data.value!.definition.fields[column].label}」为只读字段，未粘贴任何数据。`,
            );
          return { key: field(column)!, value, offset };
        });
        // Resolve parent relations first, then parse their dependent signal/field selections.
        const priority = (key: string) =>
          [
            "group_key",
            "endpoint_key",
            "internal_type",
            "sheet_type",
          ].includes(key)
            ? 0
            : 1;
        updates.sort((a, b) => priority(a.key) - priority(b.key));
        for (const { key, value, offset } of updates) {
          try {
            const original = internal?.values[index][offset],
              definition = options.data.value!.definition.fields[key];
            if (
              internal &&
              definition.reference &&
              (typeof original === "number" || typeof original === "string")
            ) {
              if (
                !pointChoices(options.scoped.value!, key, next).some(
                  (choice) => choice.id === original,
                )
              )
                throw new Error("关联记录不属于当前选择范围");
              next[key] = original;
            } else
              next[key] = parseCell(
                options.scoped.value!,
                key,
                internal ? String(original ?? "") : value,
                next,
              );
          } catch (error) {
            throw new Error(
              `第 ${start.row + index + 1} 行：${(error as Error).message}，未粘贴任何数据。`,
            );
          }
        }
        if (
          updates.some(
            (update) =>
              options.data.value!.definition.fields[update.key].reference,
          )
        )
          reconcile(next, options.scoped.value!);
        if (
          updates.some((update) =>
            update.key === "internal_type",
          )
        )
          clearStringBounds(next, row);
        changes.set(row.id, next);
      });
      setDraft(changes);
      anchor.value = { ...active.value };
      active.value = {
        id: options.rows.value[start.row + matrix.length - 1].id,
        column: options.columns.value[start.column + width - 1].key,
      };
    } catch (error) {
      options.error((error as Error).message);
    }
  }
  function entries() {
    if (!finish()) return null;
    if (options.rowWritable && options.data.value!.rows.some(row => draft.value[row.id] && !options.rowWritable!(row, values(row)))) {
      options.error("部分草稿已不在你的编辑范围内，草稿仍保留。请联系管理员确认板卡和协议权限。");
      return null;
    }
    return options.data.value!.rows.flatMap((row, index) =>
      draft.value[row.id]
        ? [
            {
              row: index + 1,
              id: row.id,
              values: draft.value[row.id],
              expected: initial(row),
            },
          ]
        : [],
    );
  }
  const activeRow = computed(() => active.value && rowById(active.value.id));
  const editorField = computed(
    () => editor.value && field(editor.value.column),
  );
  const editorDefinition = computed(
    () =>
      editorField.value &&
      options.data.value?.definition.fields[editorField.value],
  );
  const choices = computed(() => {
    const row = editor.value && rowById(editor.value.id);
    return row && editorField.value
      ? pointChoices(options.scoped.value!, editorField.value, values(row)).filter(choice => options.allowedChoice?.(row, editorField.value!, choice, values(row)) ?? true)
      : [];
  });
  watch([options.rows, options.columns], () => {
    const visibleIds = new Set(options.rows.value.map((row) => row.id));
    selectedRowIds.value = selectedRowIds.value.filter((id) =>
      visibleIds.has(id),
    );
    if (rowAnchor.value != null && !visibleIds.has(rowAnchor.value))
      rowAnchor.value = null;
    if (
      active.value &&
      (coordinates(active.value)!.row < 0 ||
        coordinates(active.value)!.column < 0)
    ) {
      active.value = null;
      anchor.value = null;
    }
  });
  return {
    applyRecommendation,
    table,
    active,
    anchor,
    editor,
    input,
    draft,
    dirty,
    changedRows,
    changedCells,
    hasHistory,
    undoStack,
    redoStack,
    selection,
    selectedRowIds,
    activeRow,
    editorDefinition,
    choices,
    initial,
    values,
    field,
    editable,
    text,
    selected,
    isRowSelected,
    selectRow,
    selectPage,
    clearSelection,
    isActive,
    isEditing,
    modified,
    reset,
    choose,
    start,
    finish,
    cancelEditor,
    keydown,
    editorKey,
    copy,
    copyRows,
    copySelection,
    paste,
    undo,
    redo,
    entries,
    focusActive,
  };
}
