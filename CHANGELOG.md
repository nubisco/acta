## [1.13.1](https://github.com/nubisco/acta/compare/v1.13.0...v1.13.1) (2026-09-09)


### Bug Fixes

* **connections:** say how to name several repositories ([2c882da](https://github.com/nubisco/acta/commit/2c882da865d6272f26825717dd9df8f76cceb162))

# [1.13.0](https://github.com/nubisco/acta/compare/v1.12.0...v1.13.0) (2026-09-09)


### Features

* upload and crop your own picture, in Acta ([e17a846](https://github.com/nubisco/acta/commit/e17a846f88f2eba192e451d17fa0a2501c977295))

# [1.12.0](https://github.com/nubisco/acta/compare/v1.11.1...v1.12.0) (2026-09-09)


### Features

* **activity:** a sortable table, filtered by picking faces ([2d4c5f3](https://github.com/nubisco/acta/commit/2d4c5f39dcfe182a50d3c0db56db99b03cc0fbc3))
* **board:** table, calendar and timeline views, and a real label filter ([e4c720e](https://github.com/nubisco/acta/commit/e4c720efb1387c7fd1d7bde9ff7ac323b0828429))
* star a board, and a favourites section on home ([10643ac](https://github.com/nubisco/acta/commit/10643acaa31770d5223795f3a6d6cd228245e5e1))

## [1.11.1](https://github.com/nubisco/acta/compare/v1.11.0...v1.11.1) (2026-09-09)


### Bug Fixes

* **db:** a semicolon in a schema comment took production down ([f645fac](https://github.com/nubisco/acta/commit/f645fac7daf02d6d1f4a46447e958a523df762a1))

# [1.11.0](https://github.com/nubisco/acta/compare/v1.10.1...v1.11.0) (2026-09-09)


### Features

* workspaces in the URL, the way an org is on GitHub ([c175c0f](https://github.com/nubisco/acta/commit/c175c0f2bc48cca72b6c5f36a58fcde0d265e55c))

## [1.10.1](https://github.com/nubisco/acta/compare/v1.10.0...v1.10.1) (2026-09-09)


### Bug Fixes

* **web:** one type scale, breadcrumbs everywhere, and a consistent sidebar ([7419ac1](https://github.com/nubisco/acta/commit/7419ac1ed99374b112c7c3c46be3c41205cdd46a))

# [1.10.0](https://github.com/nubisco/acta/compare/v1.9.0...v1.10.0) (2026-09-08)


### Features

* **web:** archive and restore buttons on the card itself ([987bd12](https://github.com/nubisco/acta/commit/987bd1235ebf3aafe5256f3feeead57fbe0e6f11))

# [1.9.0](https://github.com/nubisco/acta/compare/v1.8.0...v1.9.0) (2026-09-08)


### Bug Fixes

* **web:** card text that broke its own layout ([c15dda6](https://github.com/nubisco/acta/commit/c15dda639db9677d6e526d4b9407487e08225cd9))


### Features

* **board:** right-click a card for a context menu ([3fa236f](https://github.com/nubisco/acta/commit/3fa236f3b7d770ca2185a44c7f9f94da1aec97a6))

# [1.8.0](https://github.com/nubisco/acta/compare/v1.7.3...v1.8.0) (2026-09-08)


### Features

* delete a card, once it is archived ([5cfd87f](https://github.com/nubisco/acta/commit/5cfd87fc1420d0583cdeb36406eaf2ac36b5ad5f))

## [1.7.3](https://github.com/nubisco/acta/compare/v1.7.2...v1.7.3) (2026-09-08)


### Bug Fixes

* **settings:** reveal the ingest token alone, not the whole endpoint ([ec9aa39](https://github.com/nubisco/acta/commit/ec9aa39d687b6ce8c92dd6233ba94c5630d88329))

## [1.7.2](https://github.com/nubisco/acta/compare/v1.7.1...v1.7.2) (2026-09-08)


### Bug Fixes

* **ingest:** apply labels one at a time so a bad name costs only itself ([34ef6f6](https://github.com/nubisco/acta/commit/34ef6f632b599bc41b8faa26fc2af5263972193c))

## [1.7.1](https://github.com/nubisco/acta/compare/v1.7.0...v1.7.1) (2026-09-08)


### Bug Fixes

* **ingest:** never lose a submission over a label ([56a9768](https://github.com/nubisco/acta/commit/56a97689a4a52e9312f586c7a57ba67f5fc877f7))

# [1.7.0](https://github.com/nubisco/acta/compare/v1.6.0...v1.7.0) (2026-09-08)


### Features

* inbound GitHub connections and Slack notifications ([fc60fdd](https://github.com/nubisco/acta/commit/fc60fdd2d44e0d35331fc6d4041ece95356459d2))

# [1.6.0](https://github.com/nubisco/acta/compare/v1.5.1...v1.6.0) (2026-09-08)


### Bug Fixes

* **importers:** large attachment uploads use the raw route ([0d06102](https://github.com/nubisco/acta/commit/0d061022be551ead2774908fe7cb148bbcb7fefd))
* **search:** survive raw user input, find by key, answer while typing ([6fe8b8f](https://github.com/nubisco/acta/commit/6fe8b8f476e90ab9c44fb80c18e1e3c9c1e50f19))
* **web:** browser Back walks the inspector's card chain ([200fb3a](https://github.com/nubisco/acta/commit/200fb3aa635dde4cf22f00c3585194406b49be64))
* **web:** home tiles no longer play height games inside the card body ([f9a3c44](https://github.com/nubisco/acta/commit/f9a3c4423af43b5ebe536d5ffc180cd0887dc87c))


### Features

* avatars and display names everywhere a person appears ([3cef515](https://github.com/nubisco/acta/commit/3cef51586db387d570d9645a5033c9c3ea014179)), closes [option/#value](https://github.com/nubisco/acta/issues/value)
* **docs:** delete op and tree reveal of the current page ([1566cc3](https://github.com/nubisco/acta/commit/1566cc3b8764ae7dd35854f512661d33f0bb41d4))
* full-fidelity foundations, nothing gets lost in migrations or after them ([fb9742f](https://github.com/nubisco/acta/commit/fb9742f6ddcf8d216ad1377585b9fbd2fb11b108))
* **importers:** migrations carry provenance, comments, and everything the connector hides ([48258c7](https://github.com/nubisco/acta/commit/48258c74069549d629fe1ce038a5abc55e03455c))
* **web:** adopt @nubisco/ui end to end across the shell and views ([446d99d](https://github.com/nubisco/acta/commit/446d99d62eefc055d3cbeeca3f264d0949539e74))
* **web:** callouts carry their kind's icon ([ed2f6c7](https://github.com/nubisco/acta/commit/ed2f6c784efb5baf2fb17e439fb0709fbe5331e0))
* **web:** collapsed rail folds boards behind one menu ([2240d7d](https://github.com/nubisco/acta/commit/2240d7dc10cb0b8db6ebbea84bb35dce7069eedd))
* **web:** cross-references between docs and cards, editor typeaheads, contextual commands ([e64b9ca](https://github.com/nubisco/acta/commit/e64b9caf68a569c7af40278cff8cda88b1e74dab))
* **web:** docs adopt the shell contextbar, pages read like documents ([cd804bc](https://github.com/nubisco/acta/commit/cd804bcc4cb329472de5367ebb65f23fcf927073))
* **web:** docs tree moves left, cards get true manual ordering ([7849514](https://github.com/nubisco/acta/commit/7849514358899fc436815c14689df2c3be96f451))
* **web:** inspector deep links via ?item=KEY ([4e1a786](https://github.com/nubisco/acta/commit/4e1a786118758f99af6f97c249104902322b6e27))
* **web:** item creation moves to the topbar and the column feet ([d590309](https://github.com/nubisco/acta/commit/d590309198807d71442689405c2a844508c9ca7c))
* **web:** migrate to @nubisco/ui 4.x compile-time resolution ([17aa6d0](https://github.com/nubisco/acta/commit/17aa6d08e4e6e80278c96d3e3d7cc16228f07a61))
* **web:** redesign home board tiles as compact identity cards ([93bdc9b](https://github.com/nubisco/acta/commit/93bdc9ba40828ef8f98cf961ecde384fa62b62d6))
* **web:** the inspector carries its own back trail ([d68bc5b](https://github.com/nubisco/acta/commit/d68bc5b32631abcfb6132a6d097076ce0bb9da54))

## [1.5.1](https://github.com/nubisco/acta/compare/v1.5.0...v1.5.1) (2026-09-05)


### Bug Fixes

* **importers:** survive Workers free-plan limits during bulk import ([fda53b9](https://github.com/nubisco/acta/commit/fda53b9553a9128d7d24907640cc5ab0569a8813))

# [1.5.0](https://github.com/nubisco/acta/compare/v1.4.0...v1.5.0) (2026-09-05)


### Features

* **web:** adopt the Acta app icon and identity assets ([0e786fd](https://github.com/nubisco/acta/commit/0e786fdd213eb28b1dc526e5155a92325a7d1a07)), closes [#16253A](https://github.com/nubisco/acta/issues/16253A)

# [1.4.0](https://github.com/nubisco/acta/compare/v1.3.0...v1.4.0) (2026-09-05)


### Features

* **web:** WYSIWYG editing, item modal, richer cards and adaptive shell ([ecfaf5d](https://github.com/nubisco/acta/commit/ecfaf5dbb9772b75192e438bfe156c52a8c4c574))

# [1.3.0](https://github.com/nubisco/acta/compare/v1.2.0...v1.3.0) (2026-09-04)


### Features

* **web:** rebuild the app on the Nubisco UI 3.3.0 guidelines ([94277ba](https://github.com/nubisco/acta/commit/94277bae8efffffa29e36cc38c3fb3422fe013d8))

# [1.2.0](https://github.com/nubisco/acta/compare/v1.1.0...v1.2.0) (2026-09-04)


### Features

* external single sign-on (JWT redirect + JWKS) and member management ([2b6dd80](https://github.com/nubisco/acta/commit/2b6dd80dd1e41cfd6b423595078ea96dbb9cf590))

# [1.1.0](https://github.com/nubisco/acta/compare/v1.0.0...v1.1.0) (2026-09-04)


### Features

* Cloudflare Workers deployment target (D1, R2, assets binding) ([4454b30](https://github.com/nubisco/acta/commit/4454b307e64ce611df340cfd54df3d67902edaab))

# 1.0.0 (2026-09-04)


### Features

* initial release of Acta ([c6d686d](https://github.com/nubisco/acta/commit/c6d686d9c25e11a852eed14b4dd4bc9128c4441d))
