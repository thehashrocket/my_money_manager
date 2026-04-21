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

  return (
    <Combobox
      items={items}
      name={name}
      value={value || null}
      onValueChange={(next) =>
        onValueChange(typeof next === "string" ? next : "")
      }
      itemToStringLabel={(v) => labelFor(String(v))}
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
