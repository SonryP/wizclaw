import { h } from 'preact';
import { useEffect, useRef, useMemo } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

export function Terminal({ lines, expanded }) {
  const containerRef = useRef(null);

  // Auto-detect QR code output (block characters like █, ▀, ▄, ▐, etc.)
  const hasQR = useMemo(() => {
    if (expanded) return true;
    // Check last 50 lines for QR block characters
    const recent = lines.slice(-50);
    return recent.some((line) => /[█▀▄▌▐░▒▓╔╗╚╝║═━┃┣┫╋]/.test(line.text));
  }, [lines, expanded]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  const className = `terminal${hasQR ? ' terminal-expanded' : ''}`;

  return html`
    <div class=${className} ref=${containerRef}>
      <pre class="terminal-content">${lines.map(
        (line, i) => html`<span key=${i} class="terminal-line ${line.stream}">${line.text}</span>`
      )}</pre>
    </div>
  `;
}
