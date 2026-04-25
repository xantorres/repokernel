# Entities

All entities are markdown files with YAML frontmatter. The frontmatter is the contract; the body is human notes and is not interpreted in v0. Schemas are strict — unknown fields produce `UNKNOWN_FRONTMATTER_FIELD` (P3).

ID formats are fixed:

- Sprints: `S-` + digits (e.g. `S-001`)
- Epics: `E-` + digits (e.g. `E-001`)
- Reviews: `R-` + digits (e.g. `R-001`)
- Queue slots: `Q-` + digits (e.g. `Q-001`)

Filenames must be `<id>.md` or `<id>-<slug>.md`. Mismatch → `FILENAME_ID_MISMATCH` (P3). Queue files are exempt (no top-level id).

## Sprint

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Matches `^S-\d+$`. |
| `title` | string | yes | |
| `epic_id` | string | yes | Matches `^E-\d+$`. |
| `status` | enum | yes | `planned`\|`pending`\|`queued`\|`active`\|`review`\|`shipped`\|`reopened`\|`cancelled`. |
| `lane` | string | yes | |
| `gate` | string | no | Optional checkpoint label. |
| `depends_on` | string[] | default `[]` | Sprint ids. |
| `blocked_by` | string[] | default `[]` | Sprint ids. |
| `allowed_paths` | string[] | default `[]` | Reserved for future close-time enforcement. |
| `denied_paths` | string[] | default `[]` | Reserved. |
| `generated_paths` | string[] | default `[]` | Reserved. |
| `review_required` | boolean | default `true` | If false, shipped sprint can skip review check. |
| `review_id` | string | no | Matches `^R-\d+$`. |
| `started_at` | ISO 8601 datetime | no | Required for active per validator rule. |
| `closed_at` | ISO 8601 datetime | no | Required for shipped per validator rule. |
| `base_sha` | hex (7-40) | no | Required for active when `requireBaseShaForActive`. |
| `end_sha` | hex (7-40) | no | Required for shipped when `requireEndShaForShipped`. |

## Epic

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Matches `^E-\d+$`. |
| `title` | string | yes | |
| `status` | enum | yes | `planned`\|`active`\|`on_hold`\|`done`\|`cancelled`. |
| `gate` | string | no | |
| `adr_links` | string[] | default `[]` | Free-form ADR identifiers. |
| `sprints` | string[] | default `[]` | Sprint ids owned by this epic. |

## Review

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Matches `^R-\d+$`. |
| `sprint_id` | string | yes | Matches `^S-\d+$`. |
| `verdict` | enum | yes | `pending`\|`accepted`\|`changes_requested`\|`rejected`. |
| `reviewer` | string | yes | |
| `findings` | object[] | default `[]` | Each: `{severity: CRITICAL\|HIGH\|MEDIUM\|LOW, message: string}`. |
| `base_sha` | hex | no | |
| `end_sha` | hex | no | |
| `created_at` | ISO 8601 datetime | yes | |
| `updated_at` | ISO 8601 datetime | no | |

## Queue

One file per lane.

| Field | Type | Required | Notes |
|---|---|---|---|
| `lane` | string | yes | Lane name. |
| `slots` | object[] | default `[]` | Each: `{id: Q-N, sprint_id: S-N, order: int>=0}`. |

Queue files have no top-level id. They are identified by `lane` + path.

## Lane

Optional. If present, one file per lane.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Lane name. |
| `claimed_by` | string | no | Agent name (read-only in v0). |
| `claimed_at` | ISO 8601 datetime | no | |

If no lane files exist, lanes are inferred from `sprint.lane` and `queue.lane` values. The union of those becomes the known lane set.

## Authoring tips

- Quote ISO datetime strings if your editor or YAML parser tries to coerce them.
- Keep one entity per file.
- Bodies are append-only narrative. Don't put structured data outside frontmatter.
