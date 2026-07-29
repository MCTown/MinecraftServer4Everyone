import type { ConsoleLogEntry } from "~/types/app";
import { escapeHtml } from "~/utils/html";

interface ConsoleTextStyle {
  foreground: string | null;
  background: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

export interface RenderedConsoleLogEntry extends ConsoleLogEntry {
  html: string;
}

const ansiBasicColors = ["#0f172a", "#ef4444", "#22c55e", "#eab308", "#3b82f6", "#d946ef", "#06b6d4", "#e5e7eb"];
const ansiBrightColors = ["#64748b", "#f87171", "#4ade80", "#fde047", "#60a5fa", "#e879f9", "#22d3ee", "#ffffff"];
const minecraftLegacyColors: Record<string, string> = {
  "0": "#000000", "1": "#0000aa", "2": "#00aa00", "3": "#00aaaa", "4": "#aa0000", "5": "#aa00aa", "6": "#ffaa00", "7": "#aaaaaa", "8": "#555555", "9": "#5555ff", a: "#55ff55", b: "#55ffff", c: "#ff5555", d: "#ff55ff", e: "#ffff55", f: "#ffffff"
};

export function renderConsoleLogs(entries: ConsoleLogEntry[]): RenderedConsoleLogEntry[] {
  const style = createConsoleTextStyle();
  let pendingAnsiControl = "";
  return entries.map((entry) => {
    const rendered = renderConsoleText(`${pendingAnsiControl}${stripInteractivePromptRedraws(entry.text)}`, style);
    pendingAnsiControl = rendered.pendingAnsiControl;
    return { ...entry, html: rendered.html };
  });
}

function stripInteractivePromptRedraws(text: string) {
  // MCDReforged's prompt-toolkit redraws its input prompt when stdout is piped.
  // These empty lines are terminal UI artifacts, not server log output.
  return text.replace(/(^|\n)>[ \t]*\r?\n(?:[ \t]*\r?\n){2,}[ \t]*/g, "$1");
}

function createConsoleTextStyle(): ConsoleTextStyle {
  return { foreground: null, background: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false };
}

function resetConsoleTextStyle(style: ConsoleTextStyle) {
  Object.assign(style, createConsoleTextStyle());
}

function renderConsoleText(text: string, style: ConsoleTextStyle) {
  let html = "";
  let index = 0;
  let pendingAnsiControl = "";
  while (index < text.length) {
    const ansiIndex = text.indexOf("\u001B", index);
    const minecraftIndex = text.indexOf("§", index);
    const controlIndex = nextConsoleControlIndex(ansiIndex, minecraftIndex);
    if (controlIndex === -1) {
      html += renderStyledConsoleText(text.slice(index), style);
      break;
    }
    html += renderStyledConsoleText(text.slice(index, controlIndex), style);
    if (controlIndex === ansiIndex) {
      const consumed = consumeAnsiControl(text, controlIndex, style);
      if (!consumed) {
        pendingAnsiControl = text.slice(controlIndex);
        break;
      }
      index = consumed;
    } else {
      const consumed = consumeMinecraftLegacyControl(text, controlIndex, style);
      if (consumed) index = consumed;
      else {
        html += renderStyledConsoleText(text[controlIndex] ?? "", style);
        index = controlIndex + 1;
      }
    }
  }
  return { html, pendingAnsiControl };
}

function nextConsoleControlIndex(first: number, second: number) {
  if (first === -1) return second;
  if (second === -1) return first;
  return Math.min(first, second);
}

function renderStyledConsoleText(text: string, style: ConsoleTextStyle) {
  if (!text) return "";
  const styleAttribute = consoleTextStyleAttribute(style);
  return styleAttribute ? `<span${styleAttribute}>${escapeHtml(text)}</span>` : escapeHtml(text);
}

function consoleTextStyleAttribute(style: ConsoleTextStyle) {
  const declarations: string[] = [];
  const foreground = style.inverse ? style.background ?? "#05080d" : style.foreground;
  const background = style.inverse ? style.foreground ?? "#e5e7eb" : style.background;
  const decorations: string[] = [];
  if (foreground) declarations.push(`color: ${foreground}`);
  if (background) declarations.push(`background-color: ${background}`);
  if (style.bold) declarations.push("font-weight: 700");
  if (style.dim) declarations.push("opacity: 0.72");
  if (style.italic) declarations.push("font-style: italic");
  if (style.underline) decorations.push("underline");
  if (style.strike) decorations.push("line-through");
  if (decorations.length) declarations.push(`text-decoration: ${decorations.join(" ")}`);
  return declarations.length ? ` style="${declarations.join("; ")}"` : "";
}

function consumeAnsiControl(text: string, start: number, style: ConsoleTextStyle) {
  const introducer = text[start + 1];
  if (!introducer) return null;
  if (introducer === "[") {
    for (let cursor = start + 2; cursor < text.length; cursor += 1) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) {
        if (text[cursor] === "m") applyAnsiSgr(text.slice(start + 2, cursor), style);
        return cursor + 1;
      }
    }
    return text.length - start > 128 ? start + 1 : null;
  }
  if (introducer === "]") {
    const bellIndex = text.indexOf("\u0007", start + 2);
    const terminatorIndex = text.indexOf("\u001B\\", start + 2);
    if (bellIndex === -1 && terminatorIndex === -1) return text.length - start > 1024 ? start + 1 : null;
    if (bellIndex === -1) return terminatorIndex + 2;
    if (terminatorIndex === -1) return bellIndex + 1;
    return Math.min(bellIndex + 1, terminatorIndex + 2);
  }
  if ("()*+-./#%".includes(introducer)) return text[start + 2] ? start + 3 : null;
  return start + 2;
}

function applyAnsiSgr(parameters: string, style: ConsoleTextStyle) {
  const codes = parameters.trim() ? parameters.split(/[;:]/).filter(Boolean).map(Number).filter(Number.isFinite) : [0];
  if (!codes.length) codes.push(0);
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) resetConsoleTextStyle(style);
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 9) style.strike = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 29) style.strike = false;
    else if (code >= 30 && code <= 37) style.foreground = ansiBasicColors[code - 30] ?? null;
    else if (code === 39) style.foreground = null;
    else if (code >= 40 && code <= 47) style.background = ansiBasicColors[code - 40] ?? null;
    else if (code === 49) style.background = null;
    else if (code >= 90 && code <= 97) style.foreground = ansiBrightColors[code - 90] ?? null;
    else if (code >= 100 && code <= 107) style.background = ansiBrightColors[code - 100] ?? null;
    else if (code === 38 || code === 48) {
      const color = readExtendedAnsiColor(codes, index + 1);
      if (color) {
        if (code === 38) style.foreground = color.value;
        else style.background = color.value;
        index = color.nextIndex - 1;
      }
    }
  }
}

function readExtendedAnsiColor(codes: number[], start: number) {
  const mode = codes[start];
  if (mode === 5 && Number.isFinite(codes[start + 1])) return { value: ansi256Color(codes[start + 1] ?? 0), nextIndex: start + 2 };
  if (mode === 2 && Number.isFinite(codes[start + 1]) && Number.isFinite(codes[start + 2]) && Number.isFinite(codes[start + 3])) return { value: rgbColor(codes[start + 1] ?? 0, codes[start + 2] ?? 0, codes[start + 3] ?? 0), nextIndex: start + 4 };
  return null;
}

function ansi256Color(value: number) {
  const index = clampColorByte(value);
  if (index < 8) return ansiBasicColors[index] ?? "#ffffff";
  if (index < 16) return ansiBrightColors[index - 8] ?? "#ffffff";
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgbColor(level, level, level);
  }
  const colorIndex = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return rgbColor(levels[Math.floor(colorIndex / 36) % 6] ?? 0, levels[Math.floor(colorIndex / 6) % 6] ?? 0, levels[colorIndex % 6] ?? 0);
}

function rgbColor(red: number, green: number, blue: number) {
  return `rgb(${clampColorByte(red)}, ${clampColorByte(green)}, ${clampColorByte(blue)})`;
}

function clampColorByte(value: number) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function consumeMinecraftLegacyControl(text: string, start: number, style: ConsoleTextStyle) {
  const code = text[start + 1]?.toLowerCase();
  if (!code) return null;
  const color = minecraftLegacyColors[code];
  if (color) {
    resetConsoleTextStyle(style);
    style.foreground = color;
    return start + 2;
  }
  if (code === "r") resetConsoleTextStyle(style);
  else if (code === "l") style.bold = true;
  else if (code === "m") style.strike = true;
  else if (code === "n") style.underline = true;
  else if (code === "o") style.italic = true;
  else if (code !== "k") return null;
  return start + 2;
}
