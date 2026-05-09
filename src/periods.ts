/**
 * Period parsing — mirrors the period strings accepted by Vetroscope's
 * `getReportData` (today / yesterday / week / month / year /
 * YYYY-MM-DD / YYYY-MM-DD..YYYY-MM-DD).
 *
 * Returns ISO timestamps matching the format stored in `entries.timestamp`.
 * "Today" boundaries are local-midnight, just like the desktop app.
 */
export interface Range {
  /** Inclusive ISO start timestamp. */
  start: string;
  /** Exclusive ISO end timestamp (start of the day after `endDate`). */
  end: string;
  /** Human label, e.g. "Mon May 5". */
  label: string;
  /** Sub-label: "Today", "This Week", etc. (empty for explicit dates). */
  sublabel: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

export function parsePeriod(period: string): Range {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 86_400_000;
  let start: Date;
  let end: Date;
  let label = "";
  let sublabel = "";

  switch (period) {
    case "today":
      start = today;
      end = new Date(today.getTime() + dayMs);
      label = fmtDay(today);
      sublabel = "Today";
      break;
    case "yesterday":
      start = new Date(today.getTime() - dayMs);
      end = today;
      label = fmtDay(start);
      sublabel = "Yesterday";
      break;
    case "week": {
      const dow = today.getDay();
      const mondayOffset = dow === 0 ? 6 : dow - 1;
      start = new Date(today.getTime() - mondayOffset * dayMs);
      end = new Date(today.getTime() + dayMs);
      label = `${fmtShort(start)} – ${fmtShort(today)}`;
      sublabel = "This Week";
      break;
    }
    case "month":
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(today.getTime() + dayMs);
      label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      sublabel = "This Month";
      break;
    case "year":
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(today.getTime() + dayMs);
      label = String(now.getFullYear());
      sublabel = "This Year";
      break;
    default: {
      const rangeMatch = period.match(ISO_RANGE);
      if (rangeMatch) {
        start = new Date(rangeMatch[1] + "T00:00:00");
        const endDay = new Date(rangeMatch[2] + "T00:00:00");
        end = new Date(endDay.getTime() + dayMs);
        label = `${fmtShort(start)} – ${fmtShort(endDay)}`;
        break;
      }
      if (ISO_DATE.test(period)) {
        start = new Date(period + "T00:00:00");
        end = new Date(start.getTime() + dayMs);
        label = fmtDay(start);
        break;
      }
      throw new Error(
        `Unknown period "${period}". Expected today, yesterday, week, month, year, ` +
          `YYYY-MM-DD, or YYYY-MM-DD..YYYY-MM-DD.`
      );
    }
  }

  return { start: start.toISOString(), end: end.toISOString(), label, sublabel };
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtShort(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
