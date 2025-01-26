"use client";

import { ChatOptions, RequestMessage } from "../api";
import { getMessageTextContent } from "@/app/utils";

export interface DeepseekReasonerMessage extends RequestMessage {
  reasoning_content?: string;
}

export interface DeepseekReasonerResponse {
  choices: Array<{
    delta: {
      content: string;
      reasoning_content?: string;
    };
    message?: {
      content: string;
      reasoning_content?: string;
    };
  }>;
}

export interface DeepseekReasonerRequestPayload {
  messages: DeepseekReasonerMessage[];
  stream: boolean;
  model: string;
}

export function isDeepseekReasoner(model: string): boolean {
  return model === "deepseek-reasoner";
}

export function processDeepseekReasonerMessages(
  messages: ChatOptions["messages"],
): DeepseekReasonerMessage[] {
  const processedMessages: DeepseekReasonerMessage[] = [];

  for (const msg of messages) {
    // 跳过包含 reasoning_content 的助手消息，因为它不应该被包含在下一轮对话的上下文中
    if (
      msg.role === "assistant" &&
      (msg as DeepseekReasonerMessage).reasoning_content
    ) {
      continue;
    }

    const content = getMessageTextContent(msg);
    processedMessages.push({ role: msg.role, content });
  }

  return processedMessages;
}

export function createDeepseekReasonerPayload(
  messages: ChatOptions["messages"],
  stream: boolean,
  model: string,
): DeepseekReasonerRequestPayload {
  return {
    messages: processDeepseekReasonerMessages(messages),
    stream,
    model,
  };
}

let hasStartedReasoning = false;
let hasStartedAnswer = false;

export function parseDeepseekReasonerSSE(text: string): string | null {
  try {
    const json = JSON.parse(text) as DeepseekReasonerResponse;
    const delta = json.choices[0]?.delta;

    // 如果是第一次出现 reasoning_content，添加标记
    if (delta?.reasoning_content && !hasStartedReasoning) {
      hasStartedReasoning = true;
      return `【推理过程】\n${delta.reasoning_content}`;
    }

    // 如果是第一次出现 content，添加标记
    if (delta?.content && !hasStartedAnswer) {
      hasStartedAnswer = true;
      hasStartedReasoning = false; // 重置推理状态
      return `\n\n【回答】\n${delta.content}`;
    }

    // 后续的内容直接返回
    return delta?.reasoning_content || delta?.content || null;
  } catch (e) {
    console.error("[DeepseekReasoner] Failed to parse SSE", e);
    return null;
  }
}

export function resetDeepseekReasonerState() {
  hasStartedReasoning = false;
  hasStartedAnswer = false;
}

export function extractDeepseekReasonerMessage(
  res: DeepseekReasonerResponse,
): string {
  const message = res.choices[0]?.message;
  if (!message) return "";

  // 组合推理过程和最终答案
  const parts = [];
  if (message.reasoning_content) {
    parts.push(`【推理过程】\n${message.reasoning_content}`);
  }
  if (message.content) {
    parts.push(`【回答】\n${message.content}`);
  }

  return parts.join("\n\n");
}

// 用于处理非流式响应的工具函数
export function processDeepseekReasonerResponse(
  response: Response,
): Promise<DeepseekReasonerResponse> {
  return response.json();
}
