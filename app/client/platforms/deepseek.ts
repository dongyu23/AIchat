"use client";
// azure and openai, using same models. so using same LLMApi.
import {
  ApiPath,
  DEEPSEEK_BASE_URL,
  DeepSeek,
  REQUEST_TIMEOUT_MS,
} from "@/app/constant";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  ChatMessageTool,
  usePluginStore,
} from "@/app/store";
import { stream } from "@/app/utils/chat";
import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  SpeechOptions,
} from "../api";
import { getClientConfig } from "@/app/config/client";
import { getMessageTextContent } from "@/app/utils";
import { RequestPayload } from "./openai";
import { fetch } from "@/app/utils/stream";
import {
  isDeepseekReasoner,
  createDeepseekReasonerPayload,
  parseDeepseekReasonerSSE,
  processDeepseekReasonerResponse,
  extractDeepseekReasonerMessage,
} from "./deepseek-reasoner";

export class DeepSeekApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.deepseekUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.DeepSeek;
      baseUrl = isApp ? DEEPSEEK_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.DeepSeek)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions) {
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(DeepSeek.ChatPath);

      // 判断是否是 deepseek-reasoner 模型
      const isReasoner = isDeepseekReasoner(modelConfig.model);

      // 根据模型类型创建不同的请求负载
      const requestPayload = isReasoner
        ? createDeepseekReasonerPayload(
            options.messages,
            shouldStream,
            modelConfig.model,
          )
        : {
            messages: options.messages.map((v) => ({
              role: v.role,
              content: getMessageTextContent(v),
            })),
            stream: shouldStream,
            model: modelConfig.model,
            temperature: modelConfig.temperature,
            presence_penalty: modelConfig.presence_penalty,
            frequency_penalty: modelConfig.frequency_penalty,
            top_p: modelConfig.top_p,
          };

      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      if (shouldStream) {
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(
            useChatStore.getState().currentSession().mask?.plugin || [],
          );

        return stream(
          chatPath,
          requestPayload,
          getHeaders(),
          tools as any,
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: ChatMessageTool[]) => {
            if (isReasoner) {
              return parseDeepseekReasonerSSE(text);
            }

            const json = JSON.parse(text);
            const choices = json.choices;
            const tool_calls = choices[0]?.delta?.tool_calls;
            if (tool_calls?.length > 0) {
              const index = tool_calls[0]?.index;
              const id = tool_calls[0]?.id;
              const args = tool_calls[0]?.function?.arguments;
              if (id) {
                runTools.push({
                  id,
                  type: tool_calls[0]?.type,
                  function: {
                    name: tool_calls[0]?.function?.name as string,
                    arguments: args,
                  },
                });
              } else if (runTools[index]?.function?.arguments) {
                runTools[index].function.arguments += args;
              }
            }
            return choices[0]?.delta?.content;
          },
          // processToolMessage
          (
            requestPayload: RequestPayload,
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            requestPayload?.messages?.splice(
              requestPayload?.messages?.length,
              0,
              toolCallMessage,
              ...toolCallResult,
            );
          },
          options,
        );
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        if (isReasoner) {
          const resJson = await processDeepseekReasonerResponse(res);
          const message = extractDeepseekReasonerMessage(resJson);
          options.onFinish(message, res);
          return;
        }

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message, res);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }

  async usage() {
    return {
      used: 0,
      total: 0,
    };
  }

  async models(): Promise<LLMModel[]> {
    return [];
  }
}
