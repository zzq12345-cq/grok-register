import { getHeaders, buildCookie, generateStatsigId } from "./headers";

const SET_BIRTH_DATE_URL = "https://grok.com/rest/auth/set-birth-date";
const UPDATE_FEATURE_URL = "https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls";

// 设置生日请求体（2000年1月1日，确保18+）
const BIRTH_DATE_PAYLOAD = JSON.stringify({ birthDate: "2000-01-01T00:00:00.000Z" });

// gRPC-Web 请求体（开启 NSFW）
// 格式: 5字节帧头 + protobuf消息
const ENABLE_NSFW_PAYLOAD = new Uint8Array([
  // gRPC-Web 帧头
  0x00,                           // 标志: 0 = 数据帧
  0x00, 0x00, 0x00, 0x20,         // 长度: 32 字节
  // protobuf 消息
  0x0a, 0x02,                     // field 1 (feature_controls), length 2
  0x10, 0x01,                     // field 2 (nsfw), varint, value 1 (true)
  0x12, 0x1a,                     // field 2 (feature_name), length 26
  0x0a, 0x18,                     // nested: field 1, length 24
  // "always_show_nsfw_content" (24 bytes)
  0x61, 0x6c, 0x77, 0x61, 0x79, 0x73, 0x5f, 0x73,
  0x68, 0x6f, 0x77, 0x5f, 0x6e, 0x73, 0x66, 0x77,
  0x5f, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74
]);

function getGrpcHeaders(cookie: string): Record<string, string> {
  return {
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/grpc-web+proto",
    "Origin": "https://grok.com",
    "Referer": "https://grok.com/",
    "Cookie": cookie,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "x-grpc-web": "1",
    "x-user-agent": "connect-es/2.1.1",
    "x-statsig-id": generateStatsigId(),
    "x-xai-request-id": crypto.randomUUID(),
    "Sec-Ch-Ua": '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

async function setBirthDate(
  sso: string,
  sso_rw: string
): Promise<{ success: boolean; message: string }> {
  if (!sso_rw) {
    return { success: false, message: "需要 sso-rw token 才能设置生日" };
  }

  const cookie = buildCookie(sso, sso_rw);
  const headers = getHeaders(cookie, "https://grok.com/");

  try {
    const response = await fetch(SET_BIRTH_DATE_URL, {
      method: "POST",
      headers,
      body: BIRTH_DATE_PAYLOAD,
    });

    if (response.ok) {
      return { success: true, message: "生日已设置" };
    } else {
      const body = await response.text().catch(() => "");
      return { success: false, message: `设置生日失败: HTTP ${response.status} ${body.slice(0, 100)}` };
    }
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
}

async function enableNsfwFeature(
  sso: string,
  sso_rw: string
): Promise<{ success: boolean; message: string }> {
  const cookie = buildCookie(sso, sso_rw);
  const headers = getGrpcHeaders(cookie);

  try {
    const response = await fetch(UPDATE_FEATURE_URL, {
      method: "POST",
      headers,
      body: ENABLE_NSFW_PAYLOAD,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { success: false, message: `HTTP ${response.status} ${body.slice(0, 150)}` };
    }

    const content = new Uint8Array(await response.arrayBuffer());

    if (content.length >= 5) {
      const frameType = content[0];

      // frame_type 0 = 数据帧（成功）
      if (frameType === 0) {
        return { success: true, message: "NSFW enabled successfully" };
      }

      // frame_type 128 = trailer帧
      if (frameType === 128) {
        const trailer = new TextDecoder().decode(content.slice(5));
        if (trailer.includes("grpc-status:0") || trailer.includes("grpc-status: 0")) {
          return { success: true, message: "NSFW enabled successfully" };
        } else {
          return { success: false, message: `gRPC error: ${trailer.slice(0, 100)}` };
        }
      }
    }

    return { success: true, message: "NSFW enabled successfully" };

  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function enableNsfw(
  sso: string,
  sso_rw: string
): Promise<{ success: boolean; message: string }> {
  // Step 1: 设置生日（确保 18+）
  const birthResult = await setBirthDate(sso, sso_rw);
  // 即使生日设置失败（可能已设置过），继续尝试开启 NSFW

  // Step 2: 开启 NSFW feature (gRPC-Web)
  const nsfwResult = await enableNsfwFeature(sso, sso_rw);

  return nsfwResult;
}
