import { connection } from "next/server";
import { redirect } from "next/navigation";

/**
 * `/budget` is a thin redirect into the canonical `/budget/[year]/[month]`
 * renderer pointed at the current month.
 *
 * `await connection()` is required: without it, Next 16 prerenders this
 * route at build time, freezing `new Date()` to the deploy timestamp so
 * the redirect would send every future visit to the month this was
 * deployed. `connection()` opts into per-request rendering (review
 * decision 3A + T1A).
 */
export default async function BudgetIndexPage() {
  await connection();
  const now = new Date();
  redirect(`/budget/${now.getFullYear()}/${now.getMonth() + 1}`);
}
