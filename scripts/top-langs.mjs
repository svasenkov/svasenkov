#!/usr/bin/env node
// Generates profile/top-langs.svg with the stock github-readme-stats renderer
// (renderTopLanguages from @stats-organization/github-readme-stats-core), but
// from a repository window we control.
//
// Why: the stock top-langs query is `repositories(first: 100)` with no
// orderBy — GitHub returns the 100 OLDEST repos (createdAt ASC), so new org
// projects (e.g. autotests-ai-multistack-app with Kotlin/C#/Rust/Swift) never
// enter the window. And under GITHUB_TOKEN the ORGANIZATION_MEMBER
// affiliation does not surface org repos at all — they must be queried per
// organization directly (public org data is readable by any token).
//
// Here: for each owner below, take the most recently updated repos.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Allowlist — student orgs like autotests-cloud are intentionally absent.
const OWNERS = [
  { login: "svasenkov", type: "user", max: 100 },
  { login: "qa-guru", type: "org", max: 100 },
  { login: "autotests-ai", type: "org", max: 100 },
];
const PER_PAGE = 100;
const MAX_PAGES_PER_OWNER = 5;
const OUT_PATH = "profile/top-langs.svg";
const CARD_OPTIONS = {
  layout: "compact",
  langs_count: 30,
  theme: "transparent",
  hide_border: true,
};
// Drop tail languages below this share of total bytes.
const MIN_SHARE_PCT = 0.3;

const token = process.env.GITHUB_TOKEN || process.env.PAT_1;
if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const REPO_FIELDS = `
      pageInfo { hasNextPage endCursor }
      nodes {
        isFork
        owner { login }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }`;

const queryFor = ({ login, type }) =>
  type === "user"
    ? `query ($cursor: String) {
  user(login: "${login}") {
    repositories(ownerAffiliations: [OWNER], first: ${PER_PAGE}, after: $cursor,
      orderBy: { field: UPDATED_AT, direction: DESC }) {
      ${REPO_FIELDS}
    }
  }
}`
    : `query ($cursor: String) {
  organization(login: "${login}") {
    repositories(first: ${PER_PAGE}, after: $cursor,
      orderBy: { field: UPDATED_AT, direction: DESC }) {
      ${REPO_FIELDS}
    }
  }
}`;

const gql = async (query, cursor) => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "svasenkov-profile-stats",
    },
    body: JSON.stringify({ query, variables: { cursor } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL: ${json.errors[0].message}`);
  const root = json.data.user ?? json.data.organization;
  return root?.repositories;
};

const langs = {};
const keptByOwner = {};
for (const owner of OWNERS) {
  const query = queryFor(owner);
  let cursor = null;
  for (let page = 0; page < MAX_PAGES_PER_OWNER; page++) {
    const data = await gql(query, cursor);
    if (!data) break;
    for (const repo of data.nodes) {
      if (!repo || repo.isFork || (keptByOwner[owner.login] ?? 0) >= owner.max) continue;
      keptByOwner[owner.login] = (keptByOwner[owner.login] ?? 0) + 1;
      for (const edge of repo.languages?.edges ?? []) {
        const cur = langs[edge.node.name];
        langs[edge.node.name] = {
          name: edge.node.name,
          color: edge.node.color,
          size: (cur?.size ?? 0) + edge.size,
          count: (cur?.count ?? 0) + 1,
        };
      }
    }
    if (!data.pageInfo.hasNextPage || (keptByOwner[owner.login] ?? 0) >= owner.max) break;
    cursor = data.pageInfo.endCursor;
  }
}
console.log(
  `repos kept: ${JSON.stringify(keptByOwner)}, languages: ${Object.keys(langs).length}`,
);

const totalSize = Object.values(langs).reduce((acc, l) => acc + l.size, 0);
const topLangs = Object.fromEntries(
  Object.entries(langs)
    .sort(([, a], [, b]) => b.size - a.size)
    .filter(([, l]) => (l.size / totalSize) * 100 >= MIN_SHARE_PCT),
);

const coreDir = process.env.GRS_CORE_DIR || "node_modules";
const cardPath = path.resolve(
  coreDir,
  "node_modules/@stats-organization/github-readme-stats-core/build/cards/top-languages.js",
);

// The renderer clamps langs_count to MAXIMUM_LANGS_COUNT = 20. Raise the cap in
// the installed package so langs_count=30 renders; without it we'd silently
// get 20 rows. Pinned core, so the constant text is stable.
const cardSrc = await readFile(cardPath, "utf8");
const patchedSrc = cardSrc.replace(
  /MAXIMUM_LANGS_COUNT = \d+/,
  `MAXIMUM_LANGS_COUNT = ${CARD_OPTIONS.langs_count}`,
);
if (patchedSrc === cardSrc) {
  console.warn("MAXIMUM_LANGS_COUNT not found — output stays capped at 20");
} else {
  await writeFile(cardPath, patchedSrc);
}

const { renderTopLanguages } = await import(pathToFileURL(cardPath).href);
const svg = renderTopLanguages(topLangs, CARD_OPTIONS);
await writeFile(OUT_PATH, svg);
console.log(`wrote ${OUT_PATH}`);
