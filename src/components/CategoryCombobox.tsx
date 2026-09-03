"use client";

import type { LeafCategory } from "@/lib/categories";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

type Props = {
  id: string;
  name: string;
  value: string;
  onValueChange: (next: string) => void;
  categories: LeafCategory[];
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
};

type Item = { value: string; label: string };

/**
 * Shared searchable category picker for the inline categorize rows on
 * `/categorize` and `/transactions`. Submits the selected id via the hidden
 * input Base UI renders when `name` is set, so the existing FormData-based
 * Server Actions keep working.
 */
export function CategoryCombobox({
  id,
  name,
  value,
  onValueChange,
  categories,
  required,
  disabled,
  placeholder = "Pick a category…",
  className,
}: Props) {
  const items: Item[] = categories.map((c) => ({
    value: String(c.id),
    label: c.name,
  }));
  const labelFor = (v: string) =>
    items.find((i) => i.value === v)?.label ?? "";
  // Base UI calls itemToStringLabel/isItemEqualToValue with either the raw
  // id (string) — e.g. our controlled `value`, or each ComboboxItem's own
  // `value` prop — or the full `{ value, label }` item from `items` while
  // filtering/restoring the active item. Both callbacks need to handle both
  // shapes; this normalizes either one down to the plain id.
  const idOf = (v: unknown): string =>
    typeof v === "string" ? v : (v as Item).value;

  return (
    <Combobox
      items={items}
      name={name}
      value={value || null}
      onValueChange={(next) =>
        onValueChange(typeof next === "string" ? next : "")
      }
      itemToStringLabel={(v) => labelFor(idOf(v))}
      isItemEqualToValue={(itemValue, val) => idOf(itemValue) === idOf(val)}
      required={required}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
      />
      <ComboboxContent>
        <ComboboxList>
          {(item: Item) => (
            <ComboboxItem key={item.value} value={item.value}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>No matching category.</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}
