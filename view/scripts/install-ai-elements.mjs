import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outBase = path.join(root, 'components')

const registries = ['shimmer', 'code-block', 'suggestion', 'queue', 'tool', 'reasoning']

for (const name of registries) {
  const jsonPath = path.join(root, `tmp-${name}.json`)
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  for (const file of j.files) {
    let content = file.content
      .replaceAll('@/registry/default/ui/', '@/components/ui/')
      .replaceAll('@/registry/default/ai-elements/', '@/components/ai-elements/')
      .replace('from "./shimmer"', 'from "@/components/ai-elements/shimmer"')

    if (name === 'reasoning') {
      content = content
        .replace(
          'const streamdownPlugins = { cjk, code, math, mermaid };',
          'const streamdownPlugins = { code };'
        )
        .replace(/import \{ cjk \} from "@streamdown\/cjk";\n/, '')
        .replace(/import \{ math \} from "@streamdown\/math";\n/, '')
        .replace(/import \{ mermaid \} from "@streamdown\/mermaid";\n/, '')
    }

    const target = path.join(root, file.target)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    console.log('wrote', file.target)
  }
}
