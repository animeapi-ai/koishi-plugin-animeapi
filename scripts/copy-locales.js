// tsc emits the JSON locales itself (resolveJsonModule); this only checks they are there.
const fs = require('fs')
for (const name of ['en-US', 'zh-CN', 'ja-JP']) {
  if (!fs.existsSync(`lib/locales/${name}.json`)) throw new Error(`missing lib/locales/${name}.json`)
}
