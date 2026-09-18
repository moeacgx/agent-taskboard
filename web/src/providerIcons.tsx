import type { CSSProperties, HTMLAttributes } from "react";

const SVG_DATA_PREFIX = "data:image/svg+xml;charset=utf-8,";

function svgData(markup: string): string {
  return `${SVG_DATA_PREFIX}${encodeURIComponent(markup)}`;
}

const GENERIC_PROVIDER_ICON = svgData(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#64748b"/><path d="M7 12h10M12 7v10" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
);

const PROVIDER_FALLBACKS: Record<string, string> = {
  claude: svgData(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>',
  ),
  codex: svgData(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z"/></svg>',
  ),
  omp: svgData(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 56 56" fill="currentColor"><path d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z"/></svg>',
  ),
  grok: svgData(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none"><path fill="currentColor" d="M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916"/><path fill="currentColor" d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339"/></svg>',
  ),
};

const PASEO_PROFILE_ICON = svgData(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#5b6ee1"/><path d="M8 17V7h4.1a3 3 0 1 1 0 6H8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
);

function providerKey(provider: string | null | undefined): string {
  return (provider ?? "").trim().toLocaleLowerCase().split("/", 1)[0] ?? "";
}

/** Only server-sanitized inline SVG data URLs may cross into an img element. */
export function isSafeProviderIconUrl(value: string | null | undefined): value is string {
  return typeof value === "string"
    && value.startsWith(SVG_DATA_PREFIX)
    && value.length <= 24 * 1024;
}

export function providerIconSource(provider: string | null | undefined, iconDataUrl?: string | null): string {
  if (isSafeProviderIconUrl(iconDataUrl)) return iconDataUrl;
  return PROVIDER_FALLBACKS[providerKey(provider)] ?? GENERIC_PROVIDER_ICON;
}

/** Profile icon is a registry key, never a URL. Unknown keys fall back to the profile provider. */
export function profileIconSource(
  profileIcon: string | null | undefined,
  provider: string | null | undefined,
  providerIconDataUrl?: string | null,
): string {
  const key = (profileIcon ?? "").trim().toLocaleLowerCase();
  if (key === "paseo") return PASEO_PROFILE_ICON;
  if (key in PROVIDER_FALLBACKS) return PROVIDER_FALLBACKS[key];
  return providerIconSource(provider, providerIconDataUrl);
}

interface ProviderIconProps extends Omit<HTMLAttributes<HTMLSpanElement>, "color"> {
  provider?: string | null;
  iconDataUrl?: string | null;
  profileIcon?: string | null;
}

export function ProviderIcon({
  provider,
  iconDataUrl,
  profileIcon,
  className,
  style,
  ...props
}: ProviderIconProps) {
  const source = profileIcon === undefined
    ? providerIconSource(provider, iconDataUrl)
    : profileIconSource(profileIcon, provider, iconDataUrl);
  return (
    <span
      {...props}
      className={["provider-icon", className ?? ""].filter(Boolean).join(" ")}
      style={{
        backgroundColor: "currentColor",
        WebkitMaskImage: `url("${source}")`,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskImage: `url("${source}")`,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
        ...style,
      } as CSSProperties}
      aria-hidden="true"
    />
  );
}
