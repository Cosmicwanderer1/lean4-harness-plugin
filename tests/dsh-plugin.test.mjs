/**
 * Bundle-adapter contract tests.
 *
 * These tests intentionally do not start Lean. They verify that the package
 * can load without an independently installed DSH internal package and that
 * it hands standard JSON Schema tool definitions to the host context.
 *
 * @author ygw
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../dsh-plugin.js'

/**
 * Create the minimal Cordis context needed to observe adapter registration.
 *
 * @returns {{ context: Record<string, unknown>, tools: Array<Record<string, unknown>>, guards: Array<(execution: unknown) => unknown>, sections: Array<Record<string, unknown>>, dispose: () => void }} Mock context and recorded side effects.
 */
function createContext() {
  const tools = []
  const guards = []
  const sections = []
  const cleanup = []
  return {
    context: {
      tools: {
        register(tool) {
          tools.push(tool)
          return () => undefined
        },
        guard(guard) {
          guards.push(guard)
          return () => undefined
        },
      },
      systemPrompt: {
        getSectionOrder() {
          return 0
        },
        section(section) {
          sections.push(section)
          return () => undefined
        },
      },
      effect(callback) {
        cleanup.push(callback())
      },
      get() {
        return undefined
      },
    },
    tools,
    guards,
    sections,
    dispose() {
      for (const callback of cleanup.reverse()) callback()
    },
  }
}

/**
 * Verify the bundle uses only the host's standard raw-tool contract.
 *
 * @returns {void} Registration schema assertions complete synchronously.
 */
test('DSH Bundle 注册三项标准 JSON Schema 工具且不依赖独立 DSH 内部包', () => {
  const runtime = createContext()
  try {
    apply(runtime.context, { prewarm: false })
    assert.equal(runtime.tools.length, 3)
    assert.equal(runtime.guards.length, 1)
    assert.equal(runtime.sections.length, 1)

    const leanCheck = runtime.tools.find(tool => tool.name === 'lean_check')
    assert.ok(leanCheck)
    assert.deepEqual(leanCheck.parameters, {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Complete Lean 4 source, including precise imports, declarations and proof.',
        },
        file_name: {
          type: 'string',
          description: 'Logical .lean filename displayed in returned diagnostics.',
        },
      },
      additionalProperties: true,
      required: ['source', 'file_name'],
    })
    assert.equal(leanCheck.output.schema.type, 'object')
    assert.deepEqual(leanCheck.output.schema.required, ['fileName', 'success', 'reusedProcess', 'status', 'diagnostics', 'stderr', 'importInspection'])
    assert.equal(leanCheck.output.schema.properties.importInspection.additionalProperties, false)

    const formatter = runtime.tools.find(tool => tool.name === 'lean_format_tactic_state')
    assert.ok(formatter)
    assert.equal(formatter.output.schema.properties.state.additionalProperties, true)
    assert.doesNotThrow(() => leanCheck.presentCall(null))
  } finally {
    runtime.dispose()
  }
})
