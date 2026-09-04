"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { unarchiveCategoryAction } from "../actions";

/**
 * The reversibility half of "archive, not delete" (§7.2) — this route is
 * the only place an archived category is still findable at all once it
 * drops out of every picker and month view, so this button is the entire
 * escape hatch.
 */
export function UnarchiveButton({ categoryId, categoryName }: { categoryId: number; categoryName: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          const result = await unarchiveCategoryAction(categoryId);
          if (result.status === "error") toast.error(result.message);
          else toast.success(`"${categoryName}" is active again.`);
        });
      }}
    >
      Unarchive
    </Button>
  );
}
