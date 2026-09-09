/**
 * DeepSeek Harness / Cordis adapter for the standalone Lean 4 plugin.
 *
 * This is deliberately a thin host adapter: the persistent Lean process,
 * diagnostics, tactic-state formatting and Lake workspace handling remain in
 * the public `dist/` package.  The adapter only maps those capabilities to
 * Cordis lifecycle hooks and model-visible Harness tools.
 *
 * @author ygw
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LeanFormatter, LeanReplService } from './dist/index.js'

const ADAPTER_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000
const DEFAULT_PREWARM_TIMEOUT_MS = 90_000
const DEFAULT_BUILD_TIMEOUT_MS = 600_000
const DEFAULT_PREWARM_SOURCE = 'import Mathlib.Data.Nat.Basic\n'
const DEFAULT_MAX_RESULT_CHARS = 16_000

/** Cordis plugin identity used by the Harness loader. */
export const name = 'lean4-harness-plugin'

/** Host services that must exist before the adapter can register its tools. */
export const inject = ['tools', 'systemPrompt']

/**
 * Load the standalone Lean verifier into a DeepSeek Harness context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis runtime context.
 * @param {unknown} config User-controlled bundle configuration from Cordis.
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const service = new LeanReplService({
    cwd: options.workspaceRoot,
    lakeCommand: options.lakeCommand,
    leanCommand: options.leanCommand,
    requestTimeoutMs: options.requestTimeoutMs,
    buildTimeoutMs: options.buildTimeoutMs,
    replMode: 'lsp',
  })

  // A normal profile starts Lean lazily with the first `lean_check`, then keeps
  // that process alive for subsequent calls. Opt-in prewarming is reserved for
  // deployments willing to pay the initial import cost during profile startup.
  if (options.prewarm) {
    service.start()
    installOptionalPrewarm(service, options)
  }
  ctx.effect(() => () => service.stop())

  ctx.tools.guard(execution => mathlibGuardReason(execution, options.mathlibRoot))
  ctx.systemPrompt.section({
    name: 'tool:lean4-harness-plugin',
    order: ctx.systemPrompt.getSectionOrder('TOOL_LSP'),
    text: 'When a task requests Lean 4 code or a formal proof, generate complete source and call lean_check before calling the proof complete. Use the smallest precise Mathlib import that fits the theorem. Do not use import Mathlib merely as a default, do not run lake build, lake update, lake clean, or lake exe yourself, and do not modify the configured Mathlib checkout. Lean diagnostics are the authority.',
  })

  registerLeanCheck(ctx, service, options)
  registerLeanReplRequest(ctx, service, options)
  registerTacticStateFormatter(ctx, options)
}

/**
 * Register the primary proof-validation tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis runtime context.
 * @param {LeanReplService} service Persistent standalone verification service.
 * @param {ResolvedOptions} options Validated adapter configuration.
 * @returns {void}
 */
function registerLeanCheck(ctx, service, options) {
  ctx.tools.register(createHarnessTool({
    name: 'lean_check',
    description: 'Validate complete Lean 4 source with the configured persistent local Lean and Lake workspace. Success means Lean reported no error diagnostics.',
    parameters: {
      source: { type: 'string', required: true, description: 'Complete Lean 4 source, including precise imports, declarations and proof.' },
      file_name: { type: 'string', required: true, description: 'Logical .lean filename displayed in returned diagnostics.' },
    },
    output: {
      schema: leanCheckOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderLeanCheck(value, options.maxResultChars) }],
    },
    timeoutMs: options.requestTimeoutMs,
    async execute(args, exec) {
      assertRecord(args, 'lean_check: arguments')
      assertNonEmptyString(args.source, 'lean_check: source')
      assertNonEmptyString(args.file_name, 'lean_check: file_name')
      const inspection = await service.inspectImports(args.source, options.workspaceRoot)
      if (inspection.unbuildableImports.length > 0) {
        return preparationResult(args.file_name, inspection, 'configuration_error')
      }
      let importBuild
      if (inspection.buildTargets.length > 0) {
        const approval = ctx.get('approval')
        if (approval === undefined || exec.agent === undefined) {
          return preparationResult(args.file_name, inspection, 'authorization_unavailable')
        }
        let outcome
        try {
          outcome = await approval.request({
            agent: exec.agent,
            toolName: 'lean_check',
            callId: exec.callId,
            reason: `Lean 4 需要补齐本地 Mathlib 缓存：${inspection.buildTargets.join(', ')}。仅构建这些精确模块及其必要依赖，不执行 lake update。`,
            signal: exec.signal,
          })
        } catch {
          outcome = 'unavailable'
        }
        if (outcome !== 'allowed-once') {
          const status = outcome === 'rejected'
            ? 'authorization_rejected'
            : outcome === 'cancelled' ? 'authorization_cancelled' : 'authorization_unavailable'
          return preparationResult(args.file_name, inspection, status)
        }
        importBuild = await service.buildMissingImports(inspection, exec.signal)
        if (!importBuild.success) {
          return { ...preparationResult(args.file_name, inspection, 'build_failed'), importBuild: toolImportBuild(importBuild) }
        }
      }
      const result = await service.checkSource({ source: args.source, fileName: args.file_name, cwd: options.workspaceRoot })
      const diagnostics = result.diagnostics.map(diagnostic => ({
        severity: diagnostic.severity,
        fileName: diagnostic.filePath ?? args.file_name,
        line: diagnostic.position?.line ?? 1,
        column: diagnostic.position?.column ?? 1,
        message: diagnostic.message,
      }))
      const status = result.success
        ? diagnostics.some(diagnostic => diagnostic.severity === 'warning') ? 'verified_with_warnings' : 'verified'
        : 'invalid'
      return {
        fileName: args.file_name,
        success: result.success,
        reusedProcess: result.reusedProcess,
        status,
        diagnostics,
        stderr: truncate(result.stderr, options.maxResultChars),
        importInspection: toolImportInspection(inspection),
        ...(importBuild === undefined ? {} : { importBuild: toolImportBuild(importBuild) }),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Lean check: ${args.file_name}`, kind: 'read' }),
  }))
}

/**
 * Register the expert-level LSP/JSON-line request forwarding tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis runtime context.
 * @param {LeanReplService} service Persistent standalone verification service.
 * @param {ResolvedOptions} options Validated adapter configuration.
 * @returns {void}
 */
function registerLeanReplRequest(ctx, service, options) {
  ctx.tools.register(createHarnessTool({
    name: 'lean_repl_request',
    description: 'Send one structured request to the configured Lean LSP service. Use lean_check for ordinary proof validation.',
    parameters: {
      id: { type: 'string', required: true, description: 'Caller-selected request identifier.' },
      method: { type: 'string', required: true, description: 'Lean LSP or JSON-line REPL method name.' },
      // LSP method parameters have method-specific shapes. The DSH tool schema must nevertheless
      // declare this intentionally open object instead of relying on an implicit default.
      params: { type: 'object', additionalProperties: true, description: 'Optional method parameters.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          // LSP responses are method-specific JSON objects; retain the raw shape rather than
          // pretending every Lean method has one shared closed response contract.
          result: { type: 'object', additionalProperties: true },
          error: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: options.requestTimeoutMs,
    async execute(args) {
      assertRecord(args, 'lean_repl_request: arguments')
      assertNonEmptyString(args.id, 'lean_repl_request: id')
      assertNonEmptyString(args.method, 'lean_repl_request: method')
      if (args.params !== undefined && !isRecord(args.params)) throw new Error('lean_repl_request: params must be an object when provided')
      return await service.request({ id: args.id, method: args.method, params: isRecord(args.params) ? args.params : undefined })
    },
    presentCall: args => ({ card: 'generic', title: `Lean request: ${args.method}`, kind: 'read' }),
  }))
}

/**
 * Register deterministic tactic-state parsing and Markdown rendering.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis runtime context.
 * @param {ResolvedOptions} options Validated adapter configuration.
 * @returns {void}
 */
function registerTacticStateFormatter(ctx, options) {
  ctx.tools.register(createHarnessTool({
    name: 'lean_format_tactic_state',
    description: 'Parse Lean tactic-state text into goals and a readable Markdown representation.',
    parameters: {
      tactic_state: { type: 'string', required: true, description: 'Raw Lean tactic-state text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // `TacticState` contains a variable number of goals and contextual declarations.
          state: { type: 'object', additionalProperties: true, required: true },
          markdown: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.markdown }],
    },
    timeoutMs: options.requestTimeoutMs,
    async execute(args) {
      assertRecord(args, 'lean_format_tactic_state: arguments')
      if (typeof args.tactic_state !== 'string') throw new Error('lean_format_tactic_state: tactic_state must be a string')
      const state = LeanFormatter.parseTacticState(args.tactic_state)
      return { state, markdown: LeanFormatter.formatTacticStateMarkdown(state) }
    },
    presentCall: () => ({ card: 'generic', title: 'Format Lean tactic state', kind: 'read' }),
  }))
}

/**
 * Convert this adapter's small declarative tool format into the raw DSH tool
 * contract.  The conversion keeps the standalone plugin self-contained:
 * `@deepseek-ai/dsh-tools` is part of the host, but its independently
 * published version is not a safe runtime dependency for this repository.
 * DSH still owns tool registration, output validation, scheduling and cleanup.
 *
 * @param {{ name: string, description: string, parameters: Record<string, unknown>, output: { schema: Record<string, unknown>, render: (args: unknown, value: unknown) => Array<{ type: 'text', text: string }> }, timeoutMs?: number, execute: (args: Record<string, unknown>, execution: Record<string, unknown>) => Promise<unknown>, presentCall?: (args: Record<string, unknown>) => unknown }} definition Adapter-local tool declaration.
 * @returns {Record<string, unknown>} DSH registry-compatible raw tool definition.
 */
function createHarnessTool(definition) {
  const tool = {
    name: definition.name,
    description: definition.description,
    parameters: compileParameterSchema(definition.parameters),
    output: {
      schema: compileValueSchema(definition.output.schema),
      render: definition.output.render,
    },
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
    execute: definition.execute,
  }
  if (definition.presentCall !== undefined) {
    tool.presentCall = args => {
      try {
        return definition.presentCall(isRecord(args) ? args : {})
      } catch {
        // Presentation must be safe for replayed historical tool calls.
        return undefined
      }
    }
  }
  return tool
}

/**
 * Compile DSH's implicit open parameter object from the local concise schema.
 *
 * @param {Record<string, unknown>} properties Property declarations with an optional `required: true` marker.
 * @returns {Record<string, unknown>} Supported JSON Schema object.
 */
function compileParameterSchema(properties) {
  const compiledProperties = {}
  const required = []
  for (const [key, value] of Object.entries(properties)) {
    if (!isRecord(value)) throw new Error(`Tool parameter ${key} must be an object schema`)
    compiledProperties[key] = compileValueSchema(value)
    if (value.required === true) required.push(key)
  }
  return {
    type: 'object',
    properties: compiledProperties,
    // This matches defineTool's documented implicit parameter-root behavior.
    additionalProperties: true,
    ...(required.length === 0 ? {} : { required }),
  }
}

/**
 * Compile the subset of DSH value-schema declarations used by this plugin.
 *
 * @param {Record<string, unknown>} schema Local value-schema declaration.
 * @returns {Record<string, unknown>} Supported JSON Schema node.
 */
function compileValueSchema(schema) {
  if (!isRecord(schema) || typeof schema.type !== 'string') throw new Error('Tool schema must declare a value type')
  const annotations = {}
  for (const key of ['description', 'title', 'default', 'examples', 'enum', 'const']) {
    if (Object.hasOwn(schema, key)) annotations[key] = schema[key]
  }
  switch (schema.type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return { type: schema.type, ...annotations }
    case 'array':
      return {
        type: 'array',
        ...annotations,
        ...(schema.items === undefined ? {} : { items: compileValueSchema(asSchemaRecord(schema.items, 'array items')) }),
      }
    case 'object': {
      if (typeof schema.additionalProperties !== 'boolean') throw new Error('Object tool schema must declare additionalProperties')
      const properties = schema.properties === undefined ? undefined : asSchemaRecord(schema.properties, 'object properties')
      const compiledProperties = properties === undefined ? undefined : {}
      const required = []
      if (properties !== undefined && compiledProperties !== undefined) {
        for (const [key, value] of Object.entries(properties)) {
          const property = asSchemaRecord(value, `object property ${key}`)
          compiledProperties[key] = compileValueSchema(property)
          if (property.required === true) required.push(key)
        }
      }
      return {
        type: 'object',
        ...annotations,
        ...(compiledProperties === undefined ? {} : { properties: compiledProperties }),
        additionalProperties: schema.additionalProperties,
        ...(required.length === 0 ? {} : { required }),
      }
    }
    default:
      throw new Error(`Unsupported local tool schema type: ${schema.type}`)
  }
}

/**
 * Narrow a dynamic schema fragment to a plain object.
 *
 * @param {unknown} value Candidate schema value.
 * @param {string} context Human-readable validation context.
 * @returns {Record<string, unknown>} Object schema fragment.
 */
function asSchemaRecord(value, context) {
  if (!isRecord(value)) throw new Error(`Tool ${context} must be an object schema`)
  return value
}

/**
 * Validate a required non-empty string at the raw-tool boundary.
 *
 * @param {unknown} value Candidate user-provided value.
 * @param {string} name Field name included in an actionable error.
 * @returns {asserts value is string} Nothing; throws for invalid input.
 */
function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
}

/**
 * Validate that a raw Harness tool call has an object argument payload.
 *
 * @param {unknown} value Candidate user-provided arguments.
 * @param {string} name Field name included in an actionable error.
 * @returns {asserts value is Record<string, unknown>} Nothing; throws for invalid input.
 */
function assertRecord(value, name) {
  if (!isRecord(value)) throw new Error(`${name} must be an object`)
}

/**
 * Start an optional trusted import prewarm without making it part of tool registration.
 *
 * @param {LeanReplService} service Persistent standalone verification service.
 * @param {ResolvedOptions} options Validated adapter configuration.
 * @returns {void}
 */
function installOptionalPrewarm(service, options) {
  if (!options.prewarm) return
  let completed = false
  const timeout = setTimeout(() => {
    if (!completed) service.stop()
  }, options.prewarmTimeoutMs)
  void service.checkSource({ source: options.prewarmSource, fileName: 'Prewarm.lean', cwd: options.workspaceRoot })
    .catch(() => undefined)
    .finally(() => {
      completed = true
      clearTimeout(timeout)
    })
}

/**
 * Resolve adapter defaults and validate values received from a Cordis patch.
 *
 * @param {unknown} config Raw Cordis configuration.
 * @returns {ResolvedOptions} Validated configuration.
 */
function resolveOptions(config) {
  const value = isRecord(config) ? config : {}
  const workspaceRoot = optionalString(value.workspaceRoot) ?? resolve(ADAPTER_DIRECTORY, 'lean')
  const mathlibRoot = optionalString(value.mathlibRoot) ?? resolve(ADAPTER_DIRECTORY, '..', 'mathlib4')
  const options = {
    workspaceRoot: resolve(workspaceRoot),
    mathlibRoot: resolve(mathlibRoot),
    lakeCommand: optionalString(value.lakeCommand) ?? 'lake',
    leanCommand: optionalString(value.leanCommand) ?? 'lean',
    requestTimeoutMs: positiveInteger(value.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs'),
    buildTimeoutMs: positiveInteger(value.buildTimeoutMs, DEFAULT_BUILD_TIMEOUT_MS, 'buildTimeoutMs'),
    prewarm: value.prewarm === true,
    prewarmTimeoutMs: positiveInteger(value.prewarmTimeoutMs, DEFAULT_PREWARM_TIMEOUT_MS, 'prewarmTimeoutMs'),
    prewarmSource: optionalString(value.prewarmSource) ?? DEFAULT_PREWARM_SOURCE,
    maxResultChars: positiveInteger(value.maxResultChars, DEFAULT_MAX_RESULT_CHARS, 'maxResultChars'),
  }
  return Object.freeze(options)
}

/**
 * Produce the DSH output schema for a Lean verification result.
 *
 * @returns {object} Declarative tool output schema.
 */
function leanCheckOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      fileName: { type: 'string', required: true },
      success: { type: 'boolean', required: true },
      reusedProcess: { type: 'boolean', required: true },
      status: {
        type: 'string',
        required: true,
        enum: [
          'verified',
          'verified_with_warnings',
          'invalid',
          'authorization_required',
          'authorization_rejected',
          'authorization_cancelled',
          'authorization_unavailable',
          'build_failed',
          'configuration_error',
        ],
      },
      diagnostics: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            severity: { type: 'string', required: true, enum: ['error', 'warning', 'info'] },
            fileName: { type: 'string', required: true },
            line: { type: 'integer', required: true },
            column: { type: 'integer', required: true },
            message: { type: 'string', required: true },
          },
        },
      },
      stderr: { type: 'string', required: true },
      importInspection: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          imports: { type: 'array', required: true, items: { type: 'string' } },
          cachedImports: { type: 'array', required: true, items: { type: 'string' } },
          missingImports: { type: 'array', required: true, items: { type: 'string' } },
          buildTargets: { type: 'array', required: true, items: { type: 'string' } },
          unbuildableImports: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      importBuild: {
        type: 'object',
        additionalProperties: false,
        properties: {
          buildTargets: { type: 'array', required: true, items: { type: 'string' } },
          success: { type: 'boolean', required: true },
          output: { type: 'string', required: true },
          exitCode: { type: 'integer' },
        },
      },
    },
  }
}

/**
 * Create a stable result when dependency preparation stops before Lean validation.
 *
 * @param {string} fileName Logical Lean filename.
 * @param {{ imports: readonly string[], cachedImports: readonly string[], missingImports: readonly string[], buildTargets: readonly string[], unbuildableImports: readonly string[] }} inspection Local import-cache inspection.
 * @param {'authorization_unavailable' | 'authorization_rejected' | 'authorization_cancelled' | 'build_failed' | 'configuration_error'} status Final preparation status.
 * @returns {{ fileName: string, success: false, reusedProcess: false, status: string, diagnostics: [], stderr: string, importInspection: ReturnType<typeof toolImportInspection> }} Serializable tool result.
 */
function preparationResult(fileName, inspection, status) {
  return {
    fileName,
    success: false,
    reusedProcess: false,
    status,
    diagnostics: [],
    stderr: '',
    importInspection: toolImportInspection(inspection),
  }
}

/**
 * Convert readonly service inspection arrays into mutable JSON tool output.
 *
 * @param {{ imports: readonly string[], cachedImports: readonly string[], missingImports: readonly string[], buildTargets: readonly string[], unbuildableImports: readonly string[] }} inspection Service-owned inspection.
 * @returns {{ imports: string[], cachedImports: string[], missingImports: string[], buildTargets: string[], unbuildableImports: string[] }} JSON-safe inspection.
 */
function toolImportInspection(inspection) {
  return {
    imports: [...inspection.imports],
    cachedImports: [...inspection.cachedImports],
    missingImports: [...inspection.missingImports],
    buildTargets: [...inspection.buildTargets],
    unbuildableImports: [...inspection.unbuildableImports],
  }
}

/**
 * Convert a service-owned Lake outcome into mutable tool output.
 *
 * @param {{ buildTargets: readonly string[], success: boolean, output: string, exitCode?: number }} build Service build outcome.
 * @returns {{ buildTargets: string[], success: boolean, output: string, exitCode?: number }} JSON-safe build outcome.
 */
function toolImportBuild(build) {
  return {
    buildTargets: [...build.buildTargets],
    success: build.success,
    output: build.output,
    ...(build.exitCode === undefined ? {} : { exitCode: build.exitCode }),
  }
}

/**
 * Render a bounded model-readable Lean validation summary.
 *
 * @param {{ fileName: string, success: boolean, reusedProcess: boolean, status: string, diagnostics: Array<{ severity: string, fileName: string, line: number, column: number, message: string }>, stderr: string, importInspection?: { missingImports: string[], buildTargets: string[], unbuildableImports: string[] }, importBuild?: { success: boolean, output: string } }} value Tool output value.
 * @param {number} maxChars Maximum response length.
 * @returns {string} Markdown-like plain-text summary.
 */
function renderLeanCheck(value, maxChars) {
  const heading = `Lean 验证${value.success ? '通过' : '失败'}：${value.fileName}（${value.status}，${value.reusedProcess ? '复用常驻进程' : '新建常驻进程'}）`
  const diagnostics = value.diagnostics.length === 0
    ? '无诊断。'
    : value.diagnostics.map(item => `- ${item.severity.toUpperCase()} ${item.fileName}:${item.line}:${item.column} ${item.message}`).join('\n')
  const stderr = value.stderr.trim() === '' ? '' : `\nLean stderr：\n${value.stderr}`
  const preparation = value.importInspection === undefined
    ? ''
    : `\n导入缓存：缺失 ${value.importInspection.missingImports.length} 个；可授权构建 ${value.importInspection.buildTargets.join(', ') || '无'}；不可构建 ${value.importInspection.unbuildableImports.join(', ') || '无'}。`
  const build = value.importBuild === undefined
    ? ''
    : `\n受控构建：${value.importBuild.success ? '成功' : '失败'}。${value.importBuild.output.trim() === '' ? '' : `\n${value.importBuild.output}`}`
  return truncate(`${heading}\n${diagnostics}${preparation}${build}${stderr}`, maxChars)
}

/**
 * Return a final policy denial when a model tool attempts an unsafe Mathlib action.
 *
 * @param {unknown} execution Normalized Harness tool execution.
 * @param {string} mathlibRoot Protected local Mathlib path.
 * @returns {string | undefined} Denial message, if applicable.
 */
function mathlibGuardReason(execution, mathlibRoot) {
  if (!isRecord(execution)) return undefined
  const argumentsValue = execution.arguments
  if (!isRecord(argumentsValue) || typeof argumentsValue.command !== 'string') return undefined
  const command = argumentsValue.command
  if (/\b(?:lake|lake\.exe)\b[\s\S]{0,160}\b(?:build|update|clean|exe)\b/i.test(command)) {
    return 'Lean 4 Mathlib safety policy: do not run lake build, lake update, lake clean, or lake exe from model tools. Use lean_check for verification.'
  }
  const normalizedRoot = mathlibRoot.replaceAll('\\', '/').toLowerCase()
  const touchesMathlib = command.replaceAll('\\', '/').toLowerCase().includes(normalizedRoot)
    || (typeof argumentsValue.workdir === 'string' && argumentsValue.workdir.replaceAll('\\', '/').toLowerCase().includes(normalizedRoot))
  if (touchesMathlib && /(?:\b(?:set-content|add-content|clear-content|out-file|remove-item|rename-item|move-item|copy-item|new-item|del|erase|rd|rmdir|mkdir|touch|rm|mv|cp)\b|>>?)/i.test(command)) {
    return 'Lean 4 Mathlib safety policy: model tools must not modify the configured Mathlib checkout.'
  }
  return undefined
}

/**
 * Read a non-empty string from untrusted configuration.
 *
 * @param {unknown} value Candidate configuration value.
 * @returns {string | undefined} Trimmed value when usable.
 */
function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read a bounded positive integer from untrusted configuration.
 *
 * @param {unknown} value Candidate configuration value.
 * @param {number} fallback Default value.
 * @param {string} name Configuration field name.
 * @returns {number} Validated timeout or size.
 */
function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`lean4-harness-plugin: ${name} must be a positive safe integer no greater than 2147483647`)
  }
  return value
}

/**
 * Narrow a value to an ordinary object record.
 *
 * @param {unknown} value Candidate value.
 * @returns {value is Record<string, unknown>} Whether the value is a record.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Bound a text field without splitting a surrogate pair.
 *
 * @param {string} value Input text.
 * @param {number} maxChars Maximum length.
 * @returns {string} Original or shortened text.
 */
function truncate(value, maxChars) {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

/** @typedef {Readonly<{ workspaceRoot: string, mathlibRoot: string, lakeCommand: string, leanCommand: string, requestTimeoutMs: number, prewarm: boolean, prewarmTimeoutMs: number, prewarmSource: string, maxResultChars: number }>} ResolvedOptions */
