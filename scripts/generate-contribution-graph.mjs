import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const username = process.env.GITHUB_USERNAME || "ivanleedorillo-ops";
const token = process.env.GITHUB_TOKEN;
const outputPath = process.env.OUTPUT_PATH || "assets/contribution-graph.svg";

const levelNames = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

async function loadFromGraphql() {
  if (!token) throw new Error("GITHUB_TOKEN is not set");

  const to = new Date();
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "profile-contribution-graph",
    },
    body: JSON.stringify({
      query: `
        query ContributionGraph($login: String!, $from: DateTime!, $to: DateTime!) {
          user(login: $login) {
            contributionsCollection(from: $from, to: $to) {
              contributionCalendar {
                totalContributions
                weeks {
                  contributionDays {
                    contributionCount
                    contributionLevel
                    date
                    weekday
                  }
                }
              }
            }
          }
        }
      `,
      variables: { login: username, from: from.toISOString(), to: to.toISOString() },
    }),
  });

  if (!response.ok) throw new Error(`GitHub GraphQL returned ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors.map(({ message }) => message).join("; "));

  const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new Error(`GitHub user ${username} was not found`);

  return {
    total: calendar.totalContributions,
    weeks: calendar.weeks.map(({ contributionDays }) =>
      contributionDays.map((day) => ({
        count: day.contributionCount,
        date: day.date,
        level: levelNames[day.contributionLevel] ?? 0,
        weekday: day.weekday,
      })),
    ),
  };
}

async function loadFromPublicProfile() {
  const response = await fetch(`https://github.com/users/${encodeURIComponent(username)}/contributions`, {
    headers: { "user-agent": "profile-contribution-graph" },
  });
  if (!response.ok) throw new Error(`GitHub contribution page returned ${response.status}`);

  const html = await response.text();
  const weeks = [];
  const cellPattern = /<td\b([^>]*\bclass="[^"]*ContributionCalendar-day[^"]*"[^>]*)><\/td>/g;

  for (const match of html.matchAll(cellPattern)) {
    const attributes = match[1];
    const date = attributes.match(/\bdata-date="([^"]+)"/)?.[1];
    const level = Number(attributes.match(/\bdata-level="([0-4])"/)?.[1]);
    const week = Number(attributes.match(/\bdata-ix="(\d+)"/)?.[1]);
    const id = attributes.match(/\bid="contribution-day-component-(\d+)-\d+"/)?.[1];
    if (!date || !Number.isInteger(week) || id === undefined) continue;

    const tooltipPattern = new RegExp(`for="contribution-day-component-${id}-${week}"[^>]*>([^<]+)<\\/tool-tip>`);
    const tooltip = html.match(tooltipPattern)?.[1] || "";
    const count = Number(tooltip.match(/([\d,]+) contributions?/)?.[1]?.replaceAll(",", "") || 0);

    weeks[week] ||= [];
    weeks[week].push({ count, date, level, weekday: Number(id) });
  }

  const compactWeeks = weeks.filter(Boolean);
  if (!compactWeeks.length) throw new Error("GitHub contribution markup could not be parsed");
  return {
    total: compactWeeks.flat().reduce((sum, day) => sum + day.count, 0),
    weeks: compactWeeks,
  };
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]);
}

function render({ total, weeks }) {
  const width = 880;
  const height = 190;
  const left = 50;
  const top = 65;
  const cell = 11;
  const gap = 3;
  const step = cell + gap;
  const monthFormatter = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
  const monthLabels = [];
  let previousMonth = -1;

  for (let index = 0; index < weeks.length; index += 1) {
    const firstDay = weeks[index][0];
    if (!firstDay) continue;
    const month = new Date(`${firstDay.date}T00:00:00Z`).getUTCMonth();
    if (month !== previousMonth && index > 0) {
      monthLabels.push(`<text class="label" x="${left + index * step}" y="52">${monthFormatter.format(new Date(`${firstDay.date}T00:00:00Z`))}</text>`);
    }
    previousMonth = month;
  }

  const cells = weeks.flatMap((days, weekIndex) => days.map((day) => {
    const x = left + weekIndex * step;
    const y = top + day.weekday * step;
    const description = `${day.count} contribution${day.count === 1 ? "" : "s"} on ${day.date}`;
    return `<rect class="level-${day.level}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2"><title>${escapeXml(description)}</title></rect>`;
  })).join("\n    ");

  const gridWidth = weeks.length * step - gap;
  const legendX = Math.min(width - 112, left + gridWidth - 98);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(username)} GitHub contribution activity</title>
  <desc id="description">${total.toLocaleString("en")} contributions during the past year.</desc>
  <style>
    .card { fill: #ffffff; stroke: #d0d7de; }
    .heading { fill: #1f2328; font: 600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .label { fill: #59636e; font: 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .level-0 { fill: #eff2f5; } .level-1 { fill: #aceebb; } .level-2 { fill: #4ac26b; }
    .level-3 { fill: #2da44e; } .level-4 { fill: #116329; }
    @media (prefers-color-scheme: dark) {
      .card { fill: #0d1117; stroke: #3d444d; }
      .heading { fill: #f0f6fc; } .label { fill: #9198a1; }
      .level-0 { fill: #151b23; } .level-1 { fill: #033a16; } .level-2 { fill: #196c2e; }
      .level-3 { fill: #2ea043; } .level-4 { fill: #56d364; }
    }
  </style>
  <rect class="card" x="0.5" y="0.5" width="879" height="189" rx="8" />
  <text class="heading" x="20" y="29">${total.toLocaleString("en")} contributions in the last year</text>
  ${monthLabels.join("\n  ")}
  <text class="label" x="20" y="${top + step + 9}">Mon</text>
  <text class="label" x="20" y="${top + step * 3 + 9}">Wed</text>
  <text class="label" x="20" y="${top + step * 5 + 9}">Fri</text>
  <g>
    ${cells}
  </g>
  <text class="label" x="${legendX - 29}" y="174">Less</text>
  ${[0, 1, 2, 3, 4].map((level, index) => `<rect class="level-${level}" x="${legendX + index * step}" y="164" width="${cell}" height="${cell}" rx="2" />`).join("\n  ")}
  <text class="label" x="${legendX + 74}" y="174">More</text>
</svg>
`;
}

let data;
try {
  data = await loadFromGraphql();
  console.log("Loaded contribution data from GitHub GraphQL.");
} catch (error) {
  console.warn(`GraphQL unavailable (${error.message}); using GitHub's public profile data.`);
  data = await loadFromPublicProfile();
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, render(data), "utf8");
console.log(`Wrote ${outputPath} with ${data.total} contributions across ${data.weeks.length} weeks.`);
