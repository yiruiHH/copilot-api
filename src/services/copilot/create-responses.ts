import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  Tool,
  ToolCall,
} from "./create-chat-completions"

// --- Responses API types ---

interface ResponsesInput {
  role: string
  content: string | Array<ResponsesContentPart> | null
  tool_call_id?: string
  name?: string
  tool_calls?: Array<ToolCall>
}

interface ResponsesContentPart {
  type: string
  text?: string
  image_url?: { url: string; detail?: string }
}

interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
}

interface ResponsesAPIOutput {
  type: string
  id?: string
  content?: Array<{ type: string; text?: string }>
  name?: string
  arguments?: string
  call_id?: string
}

interface ResponsesAPIResponse {
  id: string
  object: string
  created_at: number
  model: string
  output: Array<ResponsesAPIOutput>
  usage?: {
    input_tokens: number
    output_tokens: number
    input_tokens_details?: { cached_tokens: number }
  }
  status?: string
}

interface ResponsesStreamEvent {
  type?: string
  data?: string
}

// --- Translation: ChatCompletions -> Responses ---

function translatePayload(
  payload: ChatCompletionsPayload,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model: payload.model,
    input: payload.messages.map((msg) => translateMessage(msg)),
  }

  // Only include optional parameters if they have values.
  // Note: temperature and top_p are omitted because some models
  // on the /responses endpoint don't support sampling parameters.
  if (payload.max_tokens !== undefined && payload.max_tokens !== null)
    result.max_output_tokens = payload.max_tokens
  if (payload.stream !== undefined && payload.stream !== null)
    result.stream = payload.stream
  if (payload.stop !== undefined && payload.stop !== null)
    result.stop = payload.stop
  if (payload.tools)
    result.tools = payload.tools.map((tool) => translateTool(tool))
  if (payload.tool_choice !== undefined && payload.tool_choice !== null)
    result.tool_choice = payload.tool_choice

  return result
}

function translateMessage(msg: Message): ResponsesInput {
  const input: ResponsesInput = {
    role: msg.role === "tool" ? "tool" : msg.role,
    content: msg.content as ResponsesInput["content"],
  }
  if (msg.tool_call_id) input.tool_call_id = msg.tool_call_id
  if (msg.name) input.name = msg.name
  if (msg.tool_calls) input.tool_calls = msg.tool_calls
  return input
}

function translateTool(tool: Tool): ResponsesTool {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }
}

// --- Translation: Responses -> ChatCompletions ---

function translateUsage(usage: ResponsesAPIResponse["usage"]) {
  if (!usage) return undefined
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
    ...(usage.input_tokens_details && {
      prompt_tokens_details: {
        cached_tokens: usage.input_tokens_details.cached_tokens,
      },
    }),
  }
}

function extractOutputParts(output: Array<ResponsesAPIOutput>) {
  const textParts: Array<string> = []
  const toolCalls: Array<ToolCall> = []

  for (const item of output) {
    if (item.type === "message" && item.content) {
      for (const block of item.content) {
        if (block.type === "output_text" && block.text) {
          textParts.push(block.text)
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? "",
        type: "function",
        function: {
          name: item.name ?? "",
          arguments: item.arguments ?? "{}",
        },
      })
    }
  }

  return { textParts, toolCalls }
}

function translateResponse(resp: ResponsesAPIResponse): ChatCompletionResponse {
  const { textParts, toolCalls } = extractOutputParts(resp.output)
  const hasToolCalls = toolCalls.length > 0
  const content = textParts.join("") || null

  return {
    id: resp.id,
    object: "chat.completion",
    created: resp.created_at,
    model: resp.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(hasToolCalls && { tool_calls: toolCalls }),
        },
        logprobs: null,
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: translateUsage(resp.usage),
  }
}

// --- Streaming: Responses stream -> ChatCompletions chunks ---

interface ChunkOptions {
  id: string
  delta: ChatCompletionChunk["choices"][0]["delta"]
  finishReason?: ChatCompletionChunk["choices"][0]["finish_reason"]
  model?: string
  usage?: ChatCompletionChunk["usage"]
}

function makeChunk(options: ChunkOptions): ChatCompletionChunk {
  return {
    id: options.id,
    object: "chat.completion.chunk",
    created: Date.now(),
    model: options.model ?? "",
    choices: [
      {
        index: 0,
        delta: options.delta,
        finish_reason: options.finishReason ?? null,
        logprobs: null,
      },
    ],
    ...(options.usage && { usage: options.usage }),
  }
}

function handleTextDelta(event: Record<string, unknown>): ChatCompletionChunk {
  return makeChunk({
    id: (event.response_id ?? "") as string,
    delta: { content: (event.delta ?? "") as string },
  })
}

function handleFunctionCallDelta(
  event: Record<string, unknown>,
): ChatCompletionChunk {
  return makeChunk({
    id: (event.response_id ?? "") as string,
    delta: {
      tool_calls: [
        {
          index: (event.output_index ?? 0) as number,
          id: (event.item_id ?? "") as string,
          type: "function",
          function: {
            name: "",
            arguments: (event.delta ?? "") as string,
          },
        },
      ],
    },
  })
}

function handleFunctionCallDone(
  event: Record<string, unknown>,
): ChatCompletionChunk {
  return makeChunk({
    id: (event.response_id ?? "") as string,
    delta: {
      tool_calls: [
        {
          index: (event.output_index ?? 0) as number,
          id: (event.call_id ?? event.item_id ?? "") as string,
          type: "function",
          function: {
            name: (event.name ?? "") as string,
            arguments: "",
          },
        },
      ],
    },
  })
}

function handleResponseCompleted(
  event: Record<string, unknown>,
): ChatCompletionChunk {
  const response = event.response as ResponsesAPIResponse | undefined
  return makeChunk({
    id: response?.id ?? "",
    delta: {},
    finishReason: "stop",
    model: response?.model,
    usage: response?.usage ? translateUsage(response.usage) : undefined,
  })
}

function translateStreamEvent(
  raw: ResponsesStreamEvent,
): ChatCompletionChunk | null {
  if (!raw.data || raw.data === "[DONE]") return null

  try {
    const event = JSON.parse(raw.data) as Record<string, unknown>
    const eventType = (raw.type ?? event.type ?? "") as string

    switch (eventType) {
      case "response.output_text.delta": {
        return handleTextDelta(event)
      }
      case "response.function_call_arguments.delta": {
        return handleFunctionCallDelta(event)
      }
      case "response.function_call_arguments.done": {
        return handleFunctionCallDone(event)
      }
      case "response.completed": {
        return handleResponseCompleted(event)
      }
      default: {
        return null
      }
    }
  } catch {
    consola.debug("Failed to parse responses stream event:", raw)
  }

  return null
}

// --- Main function ---

export async function createViaResponses(payload: ChatCompletionsPayload) {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const responsesPayload = translatePayload(payload)

  consola.debug(
    "Sending to /responses endpoint:",
    JSON.stringify(responsesPayload).slice(-400),
  )

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(responsesPayload),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    const stream = events(response)
    return translateResponsesStream(stream)
  }

  const resp = (await response.json()) as ResponsesAPIResponse
  return translateResponse(resp)
}

async function* translateResponsesStream(
  stream: AsyncIterable<ResponsesStreamEvent>,
) {
  for await (const raw of stream) {
    if (raw.data === "[DONE]") {
      yield { data: "[DONE]" }
      return
    }

    const chunk = translateStreamEvent(raw)
    if (chunk) {
      yield { data: JSON.stringify(chunk) }
    }
  }
}
