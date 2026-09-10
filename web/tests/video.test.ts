import { beforeEach, describe, expect, mock, test } from "bun:test";
import axios, { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";

mock.module("@/i18n", () => ({ default: { t: (key: string) => key } }));
mock.module("@/lib/image-utils", () => ({ dataUrlToFile: () => new File(["image"], "reference.png", { type: "image/png" }) }));
mock.module("@/services/image-storage", () => ({ imageToDataUrl: async (image: { dataUrl: string }) => image.dataUrl }));
mock.module("@/services/file-storage", () => ({ uploadMediaFile: async () => ({ url: "local-video", storageKey: "video" }) }));
mock.module("../src/services/api/model-plugin", () => ({ runModelPlugin: async () => ({ url: "https://media.example/plugin.mp4" }) }));

const { defaultConfig } = await import("../src/stores/use-config-store");
const { createVideoGenerationTask, pollVideoGenerationTask, waitForVideoGenerationTask, isVideoTaskFailed } = await import("../src/services/api/video");

let requests: InternalAxiosRequestConfig[];
let responses: Array<{ data: unknown; status?: number }>;
const videoBlob = new Blob(["video"], { type: "video/mp4" });

function configFor(model = "grok-imagine-video", baseUrl = "https://relay.example/v1") {
    return {
        ...defaultConfig,
        model: `relay::${model}`,
        size: "1280x720",
        videoSeconds: "6",
        vquality: "480",
        channels: [{ id: "relay", name: "Relay", baseUrl, apiKey: "test-key", apiFormat: "openai" as const, models: [{ name: model, capability: "video" as const }] }],
    };
}

beforeEach(() => {
    requests = [];
    responses = [];
    axios.defaults.adapter = async (config) => {
        requests.push(config);
        const next = responses.shift();
        if (!next) throw new Error(`Unexpected request: ${config.method} ${config.url}`);
        const response = { data: next.data, status: next.status || 200, statusText: "", headers: new AxiosHeaders(), config };
        if (response.status >= 400) throw new AxiosError("HTTP error", "ERR_BAD_RESPONSE", config, undefined, response);
        return response;
    };
});

describe("Grok video through Sub2API", () => {
    test("creates JSON and returns the remote ID before any polling", async () => {
        responses.push({ data: { request_id: "remote-1" } });
        const task = await createVideoGenerationTask(configFor(), "A red ball");
        expect(task).toEqual({ id: "remote-1", provider: "openai", model: "relay::grok-imagine-video" });
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe("https://relay.example/v1/videos");
        expect(requests[0].headers.get("Content-Type")).toBe("application/json");
        expect(JSON.parse(requests[0].data)).toEqual({ model: "grok-imagine-video", prompt: "A red ball", duration: 6, resolution: "480p", aspect_ratio: "16:9" });
    });

    test.each(["https://relay.example", "https://relay.example/v1/"])("normalizes base URL %s", async (baseUrl) => {
        responses.push({ data: { id: "remote-1" } });
        await createVideoGenerationTask(configFor("grok-imagine-video", baseUrl), "A red ball");
        expect(requests[0].url).toBe("https://relay.example/v1/videos");
    });

    test.each([["720x1280", "9:16"], ["1024x1024", "1:1"], ["auto", undefined]])("preserves aspect ratio %s", async (size, ratio) => {
        responses.push({ data: { request_id: "remote-1" } });
        await createVideoGenerationTask({ ...configFor(), size: size! }, "A red ball");
        expect(JSON.parse(requests[0].data).aspect_ratio).toBe(ratio);
    });

    test.each([["1792x1024", "7:4"], ["1024x1792", "4:7"], ["800x600", "4:3"]])("rejects unsupported aspect ratio %s without submitting", async (size, ratio) => {
        await expect(createVideoGenerationTask({ ...configFor(), size }, "A red ball")).rejects.toThrow("grokVideoErrors.unsupportedRatio");
        expect(requests).toHaveLength(0);
    });

    test("resumes from persisted metadata without creating another task", async () => {
        responses.push({ data: { request_id: "remote-1" } });
        const config = configFor();
        const created = await createVideoGenerationTask(config, "A red ball");
        const metadata = JSON.parse(JSON.stringify({ videoTaskId: created.id, model: created.model }));
        const resumed = { id: metadata.videoTaskId, provider: "openai" as const, model: metadata.model };
        responses.push({ data: { status: "pending" } });
        expect(await pollVideoGenerationTask(config, resumed)).toEqual({ status: "pending" });
        responses.push({ data: { status: "done", video: { url: "/v1/videos/remote-1/content" } } }, { data: videoBlob });
        expect(await pollVideoGenerationTask(config, resumed)).toEqual({ status: "completed", result: { blob: videoBlob } });
        expect(requests.map((request) => request.method)).toEqual(["post", "get", "get", "get"]);
        expect(requests.at(-1)?.url).toBe("https://relay.example/v1/videos/remote-1/content");
        expect(requests.every((request) => request.headers.get("Authorization") === "Bearer test-key")).toBe(true);
    });

    test("sends a single first frame as an image data URL", async () => {
        responses.push({ data: { request_id: "image-task" } });
        const image = { id: "reference", dataUrl: "data:image/png;base64,aW1hZ2U=", name: "reference.png" };
        await createVideoGenerationTask(configFor(), "Animate this image", [image]);
        expect(JSON.parse(requests[0].data).image).toEqual({ url: image.dataUrl, type: "image_url" });
    });

    test("rejects multiple first frames before creating a task", async () => {
        const image = { id: "reference", dataUrl: "data:image/png;base64,aW1hZ2U=", name: "reference.png" };
        await expect(createVideoGenerationTask(configFor(), "Animate", [image, image])).rejects.toThrow("grokVideoErrors.singleReference");
        expect(requests).toHaveLength(0);
    });

    test.each(["0x720", "1280x0", "invalid", "99999999999999999999x720"])("rejects invalid video size %s without submitting", async (size) => {
        await expect(createVideoGenerationTask({ ...configFor(), size }, "Animate")).rejects.toThrow("grokVideoErrors.invalidSize");
        expect(requests).toHaveLength(0);
    });

    test.each([new Blob(["{}"], { type: "application/json" }), new Blob(["<html>error</html>"], { type: "text/html" }), new Blob([])])("does not store an invalid content response as video", async (blob) => {
        responses.push({ data: { status: "done" } }, { data: blob });
        await expect(pollVideoGenerationTask(configFor(), { id: "remote-1", model: "relay::grok-imagine-video", provider: "openai" })).rejects.toThrow("apiErrors.videoDownloadFailed");
    });

    test("does not send the API key to a URL returned by upstream", async () => {
        responses.push({ data: { status: "done", video: { url: "https://media.example/signed.mp4" } } }, { data: videoBlob });
        const result = await pollVideoGenerationTask(configFor(), { id: "remote/1", model: "relay::grok-imagine-video", provider: "openai" });
        expect(result.status).toBe("completed");
        expect(requests.map((request) => request.url)).toEqual(["https://relay.example/v1/videos/remote%2F1", "https://relay.example/v1/videos/remote%2F1/content"]);
    });

    test.each(["failed", "error", "canceled", "cancelled"])("treats %s as a terminal failure even with a stale URL", async (status) => {
        responses.push({ data: { status, error: { message: "Generation rejected" }, video: { url: "https://media.example/stale.mp4" } } });
        try {
            await waitForVideoGenerationTask(configFor(), { id: "remote-1", model: "relay::grok-imagine-video", provider: "openai" });
            throw new Error("Expected a terminal failure");
        } catch (error) {
            expect(isVideoTaskFailed(error)).toBe(true);
            expect((error as Error).message).toBe("Generation rejected");
        }
        expect(requests).toHaveLength(1);
    });

    test("keeps download errors recoverable with the same task ID", async () => {
        const task = { id: "remote-1", model: "relay::grok-imagine-video", provider: "openai" as const };
        responses.push({ data: { status: "done" } }, { status: 502, data: { error: { message: "Download temporarily unavailable" } } });
        try {
            await waitForVideoGenerationTask(configFor(), task);
            throw new Error("Expected a download failure");
        } catch (error) {
            expect(isVideoTaskFailed(error)).toBe(false);
            expect((error as Error).message).toBe("Download temporarily unavailable");
        }
        responses.push({ data: { status: "done" } }, { data: videoBlob });
        expect(await waitForVideoGenerationTask(configFor(), task)).toEqual({ blob: videoBlob });
        expect(requests.every((request) => request.method === "get")).toBe(true);
    });

    test("does not download a moderation-rejected result", async () => {
        responses.push({ data: { status: "done", video: { url: "https://media.example/result.mp4", respect_moderation: false } } });
        const state = await pollVideoGenerationTask(configFor(), { id: "remote-1", model: "relay::grok-imagine-video", provider: "openai" });
        expect(state.status).toBe("failed");
        expect(requests).toHaveLength(1);
    });

    test("preserves multipart creation and public downloads for other video models", async () => {
        responses.push({ data: { id: "sora-1" } });
        const config = configFor("sora-2");
        const task = await createVideoGenerationTask(config, "A red ball");
        expect(requests[0].data).toBeInstanceOf(FormData);
        expect(requests[0].data.get("seconds")).toBe("6");
        expect(requests[0].data.get("preset")).toBe("normal");
        responses.push({ data: { status: "completed", video_url: "https://media.example/sora.mp4" } }, { data: videoBlob });
        expect(await pollVideoGenerationTask(config, task)).toEqual({ status: "completed", result: { blob: videoBlob } });
        expect(requests.at(-1)?.url).toBe("https://media.example/sora.mp4");
        expect(requests.at(-1)?.headers.get("Authorization")).toBeUndefined();
    });
});
