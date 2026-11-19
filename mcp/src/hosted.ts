import { toolError } from './validate.js'
import { VERSION } from './version.js'

export const HOSTED_ALLOWED_TOOLS = new Set(['get_quote', 'list_liquidity'])

export function isHostedCopy(env: NodeJS.ProcessEnv = process.env): boolean {
  return (typeof env.GLAMA_VERSION === 'string' && env.GLAMA_VERSION.length > 0) || env.PETASATS_QUOTE_ONLY === '1'
}

export const HOSTED_TOOL_REFUSAL = `This copy of the PetaSats kit runs on a shared server, such as an MCP directory's "Try in Browser", so it does not hold keys or money. get_quote and list_liquidity work here. To buy BSV, run the kit on your own machine: npx -y petasats-mcp@${VERSION}`
export const HOSTED_QUOTE_ONLY_NOTE = `This copy only gives quotes. To buy BSV, run the kit on your own machine: npx -y petasats-mcp@${VERSION}`

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export function hostedToolRefusal(): ToolResult {
  return toolError(HOSTED_TOOL_REFUSAL)
}

export function addHostedQuoteOnlyNote(result: ToolResult): ToolResult {
  return result.isError ? result : { ...result, content: [...result.content, { type: 'text', text: HOSTED_QUOTE_ONLY_NOTE }] }
}
