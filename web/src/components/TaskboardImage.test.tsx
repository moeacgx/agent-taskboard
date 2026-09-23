import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskboardImage } from "./TaskboardImage";

describe("TaskboardImage", () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();
  const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  let base: HTMLBaseElement;

  beforeEach(() => {
    base = document.createElement("base");
    base.href = "https://paseo-taskboard.invalid/?host=paseo&channel=test&nonce=test";
    document.head.append(base);
    createObjectURL.mockReset();
    revokeObjectURL.mockReset();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
  });

  afterEach(() => {
    cleanup();
    base.remove();
    if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    "api/attachments/relative/content",
    "/api/attachments/root-relative/content",
    "https://paseo-taskboard.invalid/api/attachments/resolved/content",
  ])("loads a Paseo attachment through the fetch bridge: %s", async (src) => {
    const objectUrl = `blob:${src}`;
    createObjectURL.mockReturnValue(objectUrl);
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(["image"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<TaskboardImage src={src} alt="attachment" />);

    await waitFor(() => expect(view.getByRole("img").getAttribute("src")).toBe(objectUrl));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/paseo-taskboard\.invalid\/api\/attachments\/[^/]+\/content$/),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("leaves external and non-Paseo image sources unchanged", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const external = render(<TaskboardImage src="https://images.example/image.png" alt="external" />);
    expect(external.getByRole("img").getAttribute("src")).toBe("https://images.example/image.png");
    external.unmount();

    base.href = "https://taskboard.example/";
    const regular = render(<TaskboardImage src="api/attachments/regular/content" alt="regular" />);
    expect(regular.getByRole("img").getAttribute("src")).toBe("api/attachments/regular/content");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
