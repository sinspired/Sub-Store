import { safeLoad } from '@/utils/yaml';
import { Base64 } from 'js-base64';
import { isAlias, isScalar, isSeq, parseDocument, visit } from 'yaml';
import $ from '@/core/app';

const CLASH_YAML_PARSE_OPTIONS = { merge: true, logLevel: 'error' };
const YAML_SHORT_ID_KEY_ANCHOR_RE = /&\S+\s+['"]?short-id['"]?/;

function isSafeShortIdScalar(val) {
    if (!val) return false;
    if (val === 'null' || val === '~') return true;
    const first = val[0];
    if (first === '"' || first === "'") {
        return val.length >= 2 && val[val.length - 1] === first;
    }
    if (!/^[0-9a-fA-F]+$/.test(val)) return false;
    if (/^[0-9]+$/.test(val)) return false;
    if (/^0[xXbBoO]/.test(val)) return false;
    if (/^[0-9]+[eE][0-9]+$/.test(val)) return false;
    return true;
}

function needsShortIdNormalization(raw) {
    if (YAML_SHORT_ID_KEY_ANCHOR_RE.test(raw)) {
        return true;
    }

    for (
        let idx = raw.indexOf('short-id');
        idx !== -1;
        idx = raw.indexOf('short-id', idx + 8)
    ) {
        let i = idx + 8;
        if (raw[i] === '"' || raw[i] === "'") i++;
        while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t')) i++;
        if (raw[i] !== ':') continue;

        i++;
        while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t')) i++;
        if (i >= raw.length || raw[i] === '\r' || raw[i] === '\n') {
            return true;
        }

        const quote = raw[i];
        if (quote === '"' || quote === "'") {
            let j = i + 1;
            let closed = false;
            while (j < raw.length && raw[j] !== '\r' && raw[j] !== '\n') {
                if (quote === '"' && raw[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (quote === "'" && raw[j] === "'" && raw[j + 1] === "'") {
                    j += 2;
                    continue;
                }
                if (raw[j] === quote) {
                    closed = true;
                    j++;
                    break;
                }
                j++;
            }
            if (!closed) return true;
            while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
            if (
                j < raw.length &&
                raw[j] !== ',' &&
                raw[j] !== '}' &&
                raw[j] !== '\r' &&
                raw[j] !== '\n' &&
                raw[j] !== '#'
            ) {
                return true;
            }
            continue;
        }

        let j = i;
        while (j < raw.length) {
            const ch = raw[j];
            if (
                ch === ',' ||
                ch === '}' ||
                ch === '\r' ||
                ch === '\n' ||
                ch === '#'
            ) {
                break;
            }
            j++;
        }
        const val = raw.slice(i, j).trim();
        if (!isSafeShortIdScalar(val)) {
            return true;
        }
    }

    return false;
}

function mayContainShortIds(raw) {
    return (
        typeof raw === 'string' &&
        raw.includes('short-id') &&
        needsShortIdNormalization(raw)
    );
}

export function normalizeClashYaml(raw) {
    if (!mayContainShortIds(raw)) return raw;

    try {
        const document = parseDocument(raw, CLASH_YAML_PARSE_OPTIONS);
        return normalizeClashYamlDocument(raw, document);
    } catch (e) {
        return raw;
    }
}

function normalizeClashYamlDocument(raw, document, content) {
    const anchors = new Map();
    const aliases = new Map();
    visit(document, {
        Node(_, node) {
            if (isAlias(node)) {
                aliases.set(node.range[0], anchors.get(node.source));
            } else if (node.anchor) {
                anchors.set(node.anchor, node);
            }
        },
    });
    const resolveAlias = (node) =>
        isAlias(node) ? aliases.get(node.range[0]) : node;
    const needsQuotes = (node) =>
        isScalar(node) &&
        typeof node.value !== 'string' &&
        node.value !== null &&
        !node.tag &&
        node.source;
    const realityConfigs = new Set();
    visit(document, {
        Pair(_, { key, value }) {
            const name = resolveAlias(key)?.value;
            if (['reality-opts', 'reality-config'].includes(name)) {
                realityConfigs.add(value);
            }
        },
    });
    const shortIds = new Set();
    // alias 和 merge 引用的节点也属于 REALITY 上下文。
    for (const config of realityConfigs) {
        visit(config, {
            Alias(_, alias) {
                realityConfigs.add(resolveAlias(alias));
            },
            Pair(_, { key, value }) {
                if (resolveAlias(key)?.value === 'short-id') {
                    shortIds.add(value);
                }
            },
        });
    }

    const replacements = new Map();
    // shortcut: 直接修改 anchor；跨字段共享时若需保留原类型，再隔离引用。
    for (const value of shortIds) {
        const node = resolveAlias(value);
        if (isSeq(node)) {
            for (const item of node.items) shortIds.add(item);
        } else if (needsQuotes(node)) {
            replacements.set(node, JSON.stringify(node.source));
        }
    }
    if (replacements.size === 0) return raw;

    // 需要改写时才校验全文，保留旧式 !<str> 的恢复行为。
    if (content === undefined) {
        content = document.errors.length > 0 ? safeLoad(raw) : document.toJS();
    }
    if (
        ![content?.proxies, content?.listeners].some(
            (items) => Array.isArray(items) && items.length > 0,
        )
    )
        return raw;

    const chunks = [];
    let offset = 0;
    for (const [node, content] of [...replacements].sort(
        ([left], [right]) => left.range[0] - right.range[0],
    )) {
        chunks.push(raw.slice(offset, node.range[0]), content);
        offset = node.range[1];
    }
    return chunks.join('') + raw.slice(offset);
}

function HTML() {
    const name = 'HTML';
    const test = (raw) => /^<!DOCTYPE html>/.test(raw);
    // simply discard HTML
    const parse = () => '';
    return { name, test, parse };
}

function Base64Encoded() {
    const name = 'Base64 Pre-processor';

    const keys = [
        'dm1lc3M', // vmess
        'c3NyOi8v', // ssr://
        'c29ja3M6Ly', // socks://
        'dHJvamFu', // trojan
        'c3M6Ly', // ss:/
        'c3NkOi8v', // ssd://
        'c2hhZG93', // shadow
        'aHR0c', // htt
        'dmxlc3M=', // vless
        'aHlzdGVyaWEy', // hysteria2
        'aHkyOi8v', // hy2://
        'd2lyZWd1YXJkOi8v', // wireguard://
        'd2c6Ly8=', // wg://
        'dHVpYzovLw==', // tuic://
    ];

    const test = function (raw) {
        return (
            Base64.isValid(raw) &&
            !/^\w+:\/\/\w+/im.test(raw) &&
            keys.some((k) => raw.indexOf(k) !== -1)
        );
    };
    const parse = function (raw) {
        const decoded = Base64.decode(raw);
        if (!/^\w+(:\/\/|\s*?=\s*?)\w+/m.test(decoded)) {
            $.error(
                `Base64 Pre-processor error: decoded line does not start with protocol`,
            );
            return raw;
        }

        return decoded;
    };
    return { name, test, parse };
}

function fallbackBase64Encoded() {
    const name = 'Fallback Base64 Pre-processor';

    const test = function (raw) {
        return Base64.isValid(raw);
    };
    const parse = function (raw) {
        const decoded = Base64.decode(raw);
        if (!/^\w+(:\/\/|\s*?=\s*?)\w+/m.test(decoded)) {
            $.error(
                `Fallback Base64 Pre-processor error: decoded line does not start with protocol`,
            );
            return raw;
        }

        return decoded;
    };
    return { name, test, parse };
}

function parseClashJsonLines(raw) {
    if (!raw.startsWith('proxies:\n') && !raw.startsWith('proxies:\r\n')) {
        return null;
    }
    if (
        raw.includes('short-id') &&
        /["']?short-id["']?\s*:\s*[^"'\s]/.test(raw)
    ) {
        return null;
    }
    const lines = raw.split(/\r?\n/);
    const proxies = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (!line.startsWith('  - {') || !line.endsWith('}')) {
            return null;
        }
        try {
            proxies.push(JSON.parse(line.slice(4)));
        } catch (e) {
            return null;
        }
    }
    return proxies.length > 0 ? proxies : null;
}

function Clash() {
    const name = 'Clash Pre-processor';
    const prepare = function (raw, detect) {
        if (detect && !/proxies/.test(raw)) return false;

        const jsonProxies = parseClashJsonLines(raw);
        if (jsonProxies) {
            return { content: { proxies: jsonProxies } };
        }

        let document;
        let content;
        if (mayContainShortIds(raw)) {
            try {
                document = parseDocument(raw, CLASH_YAML_PARSE_OPTIONS);
                if (document.errors.length === 0) content = document.toJS();
            } catch (e) {
                document = undefined;
            }
        }
        if (content === undefined) content = safeLoad(raw);

        if (
            detect &&
            !Array.isArray(content.proxies) &&
            !Array.isArray(content['proxy-groups'])
        )
            return false;

        if (document) {
            const normalized = normalizeClashYamlDocument(
                raw,
                document,
                content,
            );
            if (normalized !== raw) return { normalized };
        }
        return { content };
    };
    const test = (raw) => prepare(raw, true);
    const parse = function (raw, includeProxies, match = prepare(raw)) {
        const { proxies } =
            match.normalized === undefined
                ? match.content
                : safeLoad(match.normalized);
        return (
            (includeProxies ? 'proxies:\n' : '') +
            (Array.isArray(proxies) ? proxies : [])
                .map((p) => {
                    return `${includeProxies ? '  - ' : ''}${JSON.stringify(
                        p,
                    )}\n`;
                })
                .join('')
        );
    };
    return { name, test, parse };
}

function SSD() {
    const name = 'SSD Pre-processor';
    const test = function (raw) {
        return raw.indexOf('ssd://') === 0;
    };
    const parse = function (raw) {
        // preprocessing for SSD subscription format
        const output = [];
        let ssdinfo = JSON.parse(Base64.decode(raw.split('ssd://')[1]));
        let port = ssdinfo.port;
        let method = ssdinfo.encryption;
        let password = ssdinfo.password;
        // servers config
        let servers = ssdinfo.servers;
        for (let i = 0; i < servers.length; i++) {
            let server = servers[i];
            method = server.encryption ? server.encryption : method;
            password = server.password ? server.password : password;
            let userinfo = Base64.encode(method + ':' + password);
            let hostname = server.server;
            port = server.port ? server.port : port;
            let tag = server.remarks ? server.remarks : i;
            let plugin = server.plugin_options
                ? '/?plugin=' +
                encodeURIComponent(
                    server.plugin + ';' + server.plugin_options,
                )
                : '';
            output[i] =
                'ss://' +
                userinfo +
                '@' +
                hostname +
                ':' +
                port +
                plugin +
                '#' +
                tag;
        }
        return output.join('\n');
    };
    return { name, test, parse };
}

function FullConfig() {
    const name = 'Full Config Preprocessor';
    const test = function (raw) {
        return /^(\[server_local\]|\[Proxy\])/gm.test(raw);
    };
    const parse = function (raw) {
        const match = raw.match(
            /^\[server_local|Proxy\]([\s\S]+?)^\[.+?\](\r?\n|$)/im,
        )?.[1];
        return match || raw;
    };
    return { name, test, parse };
}

export default [
    HTML(),
    Clash(),
    Base64Encoded(),
    SSD(),
    FullConfig(),
    fallbackBase64Encoded(),
];
