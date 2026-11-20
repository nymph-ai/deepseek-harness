/** Standard ACP MCP-server declarations translated into Agent-scoped DSH MCP clients. */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { isAbsolute } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { McpServer as V2McpServer } from 'acp-v2-sdk/experimental/v2/unstable'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Caller-correctable MCP declaration failure. */
export class AcpMcpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpMcpConfigError'
  }
}

/** Local operator configuration for the delegated reply transport. */
export interface ChannelReplyMcp {
  /** Absolute path to the world-mcp-channel-reply executable. */
  command: string
  /** Absolute path to the authenticated fabd socket. */
  socket: string
}

/**
 * Resolve the only ACP v2 MCP server supported by the preview.
 * @param servers - Optional wire declarations. An empty list mounts no tools.
 * @param config - The local helper and socket to allow. Omitted configuration rejects all declarations.
 * @param sessionId - Existing ACP session that will own the MCP client.
 * @returns The scoped declaration in the native MCP mount's stdio format.
 */
export function channelReplyServers(
  servers: readonly V2McpServer[] | undefined,
  config: ChannelReplyMcp | undefined,
  sessionId: string,
): McpServer[] {
  if (!servers?.length) return []
  const [server] = servers
  if (config === undefined || servers.length !== 1 || server === undefined || !V2McpServer.isStdio(server)
    || server.name !== 'channel_reply' || server.command !== config.command) {
    throw new AcpMcpConfigError('ACP v2 only mounts the configured channel_reply stdio server on resume')
  }
  const { args = [], env = [] } = server
  const [socket, session, source, event] = args
  if (args.length !== 4 || socket !== config.socket || session !== sessionId || !source || !event
    || /[\u0000-\u001f\u007f]/.test(source) || /[\u0000-\u001f\u007f]/.test(event)) {
    throw new AcpMcpConfigError('channel_reply MCP arguments must name the configured socket, resumed session, source, and event')
  }
  const environment = entriesToRecord(env, 'channel_reply MCP environment', 'environment')
  if (env.length !== 2 || environment.FABD_CHANNEL_REPLY_OWNER_HELLO !== '1'
    || !/^[A-Fa-f0-9]{64}$/.test(environment.FABD_CHANNEL_REPLY_KEY ?? '')) {
    throw new AcpMcpConfigError('channel_reply MCP needs a delegated key and owner hello environment')
  }
  return [{ name: server.name, command: config.command, args, env }]
}

/**
 * Validate and mount one session's complete standard MCP server list before Agent publication.
 * @param agentCtx - unpublished Agent scope that owns the MCP clients and tools.
 * @param servers - stable ACP stdio or HTTP server declarations.
 * @param sessionCwd - canonical primary workspace used by stdio servers.
 */
export async function mountAcpMcpServers(
  agentCtx: Context,
  servers: readonly McpServer[],
  sessionCwd: string,
): Promise<void> {
  const configs = resolveMcpConfigs(servers, sessionCwd)
  for (const config of configs) await agentCtx.plugin(McpClient, config)
}

/** Convert the stable stdio/HTTP ACP transports and reject every other transport. */
function resolveMcpConfigs(servers: readonly McpServer[], sessionCwd: string): McpClient.Config[] {
  const names = new Set<string>()
  return servers.map((server, index) => {
    const serverName = normalizeServerName(server.name)
    if (names.has(serverName)) {
      throw new AcpMcpConfigError(`mcpServers contains duplicate normalized name: ${serverName}`)
    }
    names.add(serverName)
    if (!('type' in server)) {
      if (!isAbsolute(server.command)) {
        throw new AcpMcpConfigError(`mcpServers[${index}].command must be an absolute path`)
      }
      const env = entriesToRecord(server.env, `mcpServers[${index}].env`, 'environment')
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: 'stdio',
        serverName,
        command: server.command,
        args: server.args,
        env,
        cwd: sessionCwd,
        failOnStartupError: true,
      }))
      return { ...config, env }
    }
    if (server.type === 'http') {
      assertHttpUrl(server.url, `mcpServers[${index}].url`)
      const headers = entriesToRecord(server.headers, `mcpServers[${index}].headers`, 'header')
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: 'streamable-http',
        serverName,
        url: server.url,
        headers,
        failOnStartupError: true,
      }))
      return { ...config, headers }
    }
    throw new AcpMcpConfigError(`mcpServers[${index}] transport ${server.type} is not supported`)
  })
}

/** Convert ordered ACP name/value entries without silently accepting duplicate keys. */
function entriesToRecord(
  entries: readonly { name: string; value: string }[],
  field: string,
  kind: 'environment' | 'header',
): Record<string, string> {
  // Valid environment and header names include "__proto__"; a null prototype
  // keeps that entry as data instead of invoking Object.prototype's setter.
  const result = Object.create(null) as Record<string, string>
  const names = new Set<string>()
  for (const entry of entries) {
    if (kind === 'header') {
      try {
        validateHeaderName(entry.name)
        validateHeaderValue(entry.name, entry.value)
      } catch (_invalidHeader) {
        throw new AcpMcpConfigError(`${field} contains an invalid header entry`)
      }
    } else if (
      entry.name.length === 0
      || entry.name.includes('=')
      || entry.name.includes('\0')
      || entry.value.includes('\0')
    ) {
      throw new AcpMcpConfigError(`${field} contains an invalid environment entry`)
    }
    const identity = kind === 'header' ? entry.name.toLowerCase() : entry.name
    if (names.has(identity)) throw new AcpMcpConfigError(`${field} contains duplicate name: ${entry.name}`)
    names.add(identity)
    result[entry.name] = entry.value
  }
  return result
}

/** Produce a stable DSH tool namespace from ACP's human-readable server name. */
function normalizeServerName(name: string): string {
  if (name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AcpMcpConfigError('mcpServers contains an invalid server name')
  }
  if (VALID_SERVER_NAME.test(name)) return name
  const slug = name.normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'server'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

/** Require the stable Streamable HTTP transport URL schemes. */
function assertHttpUrl(value: string, field: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  } catch (_invalidUrl) {
    throw new AcpMcpConfigError(`${field} must be an absolute HTTP(S) URL`)
  }
}

/** Map the existing MCP provider's schema error into ACP invalid params. */
function validateClientConfig(index: number, parse: () => McpClient.Config): McpClient.Config {
  try {
    return parse()
  } catch (error: unknown) {
    /* v8 ignore next -- Schemastery validation rejects with Error instances. */
    const detail = error instanceof Error ? error.message : String(error)
    throw new AcpMcpConfigError(`mcpServers[${index}] is invalid: ${detail}`)
  }
}
