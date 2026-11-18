# Board-owned expert packages

The builtin directory contains all 220 expert manifests, system prompts and original board workflows. catalog.json lists their stable IDs. library.json records upstream source paths, commits and SHA-256 for 157 selected skills. The library directory preserves their supporting files and source licenses.

The CLI seeds packages into the selected board and lazily copies a chosen skill into that expert's directory. No provider configuration or global skill directory is modified. Upstream skill frontmatter is instructional data; provider hooks, plugins and permission grants are not imported. Runtime dependencies and service access remain environment requirements.
