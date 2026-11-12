#!/usr/bin/env node
// Generates profile/top-langs.svg with the stock github-readme-stats renderer
// (renderTopLanguages from @stats-organization/github-readme-stats-core), but
// from a repository window we control.
//
// Why: the stock top-langs query is `repositories(first: 100)` with no
// orderBy — GitHub returns the 100 OLDEST repos (createdAt ASC), so new org
// projects (e.g. autotests-ai-multistack-app with Kotlin/C#/Rust/Swift) never
// enter the window, and org-member repos flood it with student homework.
//
// Here: most recently updated repos, keep only the owners below.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOGIN = "svasenkov";
const OWNER_ALLOWLIST = new Set(["svasenkov", "qa-guru", "autotests-ai"]);
const MAX_REPOS = 100;
const MAX_PAGES = 15;
const OUT_PATH = "profile/top-langs.svg";
const CARD_OPTIONS = {
  layout: "compact",
  langs_count: 20,
  theme: "transparent",
  hide_border: true,
};

const token = process.env.GITHUB_TOKEN || process.env.PAT_1;
if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const QUERY = `query ($cursor: String) {
  user(login: "${LOGIN}") {
    repositories(
      ownerAffiliations: [OWNER, ORGANIZATION_MEMBER]
      isFork: false
      first: 100
      after: $cursor
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        owner { login }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

const gql = async (cursor) => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "svasenkov-profile-stats",
    },
    body: JSON.stringify({ query: QUERY, variables: { cursor } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL: ${json.errors[0].message}`);
  return json.data.user.repositories;
};

const langs = {};
const keptByOwner = {};
let kept = 0;
let scanned = 0;
let cursor = null;
for (let page = 0; page < MAX_PAGES && kept < MAX_REPOS; page++) {
  const data = await gql(cursor);
  scanned += data.nodes.length;
  for (const repo of data.nodes) {
    if (!repo || !OWNER_ALLOWLIST.has(repo.owner?.login)) continue;
    kept++;
    keptByOwner[repo.owner.login] = (keptByOwner[repo.owner.login] ?? 0) + 1;
    for (const edge of repo.languages?.edges ?? []) {
      const cur = langs[edge.node.name];
      langs[edge.node.name] = {
        name: edge.node.name,
        color: edge.node.color,
        size: (cur?.size ?? 0) + edge.size,
        count: (cur?.count ?? 0) + 1,
      };
    }
    if (kept >= MAX_REPOS) break;
  }
  if (!data.pageInfo.hasNextPage) break;
  cursor = data.pageInfo.endCursor;
}
console.log(
  `scanned: ${scanned}, repos kept: ${kept} ${JSON.stringify(keptByOwner)}, languages: ${Object.keys(langs).length}`,
);

const topLangs = Object.fromEntries(
  Object.entries(langs).sort(([, a], [, b]) => b.size - a.size),
);

const coreDir = process.env.GRS_CORE_DIR || "node_modules";
const cardPath = path.resolve(
  coreDir,
  "node_modules/@stats-organization/github-readme-stats-core/build/cards/top-languages.js",
);
const { renderTopLanguages } = await import(pathToFileURL(cardPath).href);
const svg = renderTopLanguages(topLangs, CARD_OPTIONS);
await writeFile(OUT_PATH, svg);
console.log(`wrote ${OUT_PATH}`);
