import type * as THREE from 'three';

/**
 * When the game cannot render on someone's device (an ARM laptop, an older
 * phone GPU), they usually just see a black or frozen screen. This shows
 * what went wrong on screen instead, with the GPU name, so a friend can send
 * a screenshot: runtime errors, shaders the GPU refused to compile, and a
 * lost WebGL context (GPU reset / out of memory).
 */

let panel: HTMLDivElement | null = null;
const lines: string[] = [];
let gpu = '';

function show(message: string): void {
  if (lines.includes(message) || lines.length > 6) return;
  lines.push(message);
  if (!panel) {
    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;left:8px;right:8px;bottom:8px;z-index:9999;max-height:40vh;overflow:auto;' +
      'background:rgba(120,10,10,.92);color:#fff;font:12px/1.4 ui-monospace,monospace;padding:10px 12px;' +
      'border-radius:8px;white-space:pre-wrap;user-select:text';
    const close = document.createElement('button');
    close.textContent = '닫기';
    close.style.cssText = 'float:right;margin-left:8px;font:inherit;padding:2px 8px';
    close.onclick = () => panel?.remove();
    panel.appendChild(close);
    panel.appendChild(document.createElement('pre'));
    document.body.appendChild(panel);
  }
  const pre = panel.querySelector('pre')!;
  pre.style.cssText = 'margin:0;white-space:pre-wrap';
  pre.textContent = `⚠️ 화면 오류 (이 화면을 캡처해서 보내 주세요)\n${navigator.userAgent}\nGPU: ${gpu || '?'}\n\n${lines.join('\n')}`;
}

/** Page-wide error hooks; call once at startup. */
export function installDiagnostics(): void {
  window.addEventListener('error', (e) => show(`오류: ${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => show(`오류: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));
  // WebGL2 missing altogether.
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) show('이 브라우저/기기는 WebGL2를 지원하지 않습니다. 최신 Chrome, Edge, Safari로 열어 주세요.');
  else {
    const info = probe.getExtension('WEBGL_debug_renderer_info');
    gpu = info ? String(probe.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(probe.getParameter(probe.RENDERER));
    probe.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** Renderer-level hooks: shader compile failures and context loss. */
export function watchRenderer(renderer: THREE.WebGLRenderer): void {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  if (info) gpu = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  renderer.debug.onShaderError = (glCtx, _program, vs, fs) => {
    const log = (s: WebGLShader) => (glCtx.getShaderParameter(s, glCtx.COMPILE_STATUS) ? '' : glCtx.getShaderInfoLog(s)?.trim().slice(0, 300) ?? '');
    show(`셰이더 컴파일 실패: ${log(vs)} ${log(fs)}`.trim());
  };
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    show('그래픽 컨텍스트가 끊겼습니다(GPU 메모리 부족 또는 드라이버 재시작). ?fx=0&shadows=0 을 주소 끝에 붙여 다시 열어 보세요.');
  });
}
