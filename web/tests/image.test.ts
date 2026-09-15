import { beforeEach, describe, expect, mock, test } from "bun:test";
import axios, { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";

mock.module("@/i18n", () => ({ default: { t: (key: string) => key } }));
mock.module("@/stores/use-config-store", () => ({
    buildApiUrl: (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, "")}/v1${path}`,
    resolveModelRequestConfig: (config: Record<string, unknown>, value: string) => ({ ...config, model: value }),
    resolveModelScript: () => "",
}));
mock.module("@/services/image-storage", () => ({ imageToDataUrl: async (image: { dataUrl: string }) => image.dataUrl }));
mock.module("@/lib/image-utils", () => ({ dataUrlToFile: () => new File(["image"], "reference.png", { type: "image/png" }) }));
mock.module("../src/services/api/model-plugin", () => ({ normalizePluginImages: () => [], runModelPlugin: async () => "" }));

const { requestGeneration } = await import("../src/services/api/image");

let requests: InternalAxiosRequestConfig[];
let responsePayload: unknown;

beforeEach(() => {
    requests = [];
    responsePayload = {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }],
    };
    axios.defaults.adapter = async (config) => {
        requests.push(config);
        return {
            data: responsePayload,
            status: 200,
            statusText: "OK",
            headers: new AxiosHeaders(),
            config,
        };
    };
});

function geminiConfig(overrides: Record<string, unknown> = {}) {
    return {
        model: "gemini-3-pro-image-preview",
        imageModel: "gemini-3-pro-image-preview",
        baseUrl: "https://images.example",
        apiKey: "gemini-test-key",
        apiFormat: "gemini",
        size: "1:1",
        quality: "medium",
        count: "1",
        systemPrompt: "",
        ...overrides,
    } as any;
}

describe("Gemini image request format", () => {
    test("uses native imageConfig and Gemini authentication", async () => {
        await requestGeneration(geminiConfig(), "A red ball");

        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe("https://images.example/v1beta/models/gemini-3-pro-image-preview:generateContent");
        expect(requests[0].headers.get("x-goog-api-key")).toBe("gemini-test-key");

        const body = JSON.parse(String(requests[0].data));
        expect(body.generationConfig).toEqual({
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: "1:1", imageSize: "2K" },
        });
        expect(body.generationConfig.responseFormat).toBeUndefined();
    });

    test("does not send imageConfig when size is auto", async () => {
        await requestGeneration(geminiConfig({ size: "auto", quality: "auto" }), "A red ball");

        const body = JSON.parse(String(requests[0].data));
        expect(body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"] });
        expect(body.generationConfig.responseFormat).toBeUndefined();
    });

    test("accepts hosted URLs returned as snake_case Gemini file data", async () => {
        responsePayload = {
            candidates: [{ content: { parts: [{ file_data: { mime_type: "image/jpeg", file_uri: "https://gemini9.example/generation/result.jpg" } }] } }],
        };

        const images = await requestGeneration(geminiConfig(), "A red ball");

        expect(images[0]?.dataUrl).toBe("https://gemini9.example/generation/result.jpg");
    });

    test("accepts hosted URLs wrapped in an OpenAI-style data array", async () => {
        responsePayload = { data: [{ url: "https://gemini9.example/generation/result.jpg" }] };

        const images = await requestGeneration(geminiConfig(), "A red ball");

        expect(images[0]?.dataUrl).toBe("https://gemini9.example/generation/result.jpg");
    });

    test("extracts a hosted image URL from a relay text part", async () => {
        responsePayload = {
            candidates: [{ content: { parts: [{ text: "![generated image](https://gemini9.example/generation/result.jpg)" }] } }],
        };

        const images = await requestGeneration(geminiConfig(), "A red ball");

        expect(images[0]?.dataUrl).toBe("https://gemini9.example/generation/result.jpg");
    });
});
