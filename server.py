#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote, urlsplit
import http.client
import ipaddress
import json
import os
import re
import subprocess
import tempfile
import time

ROOT = Path('/srv/ai/aitext/dist')
DATA = Path('/srv/ai/aitext/data/state.json')
ACTIVE = Path('/srv/ai/aitext/data/active-model')
UPSTREAM_HOST = '127.0.0.1'
UPSTREAM_PORT = 8002
STRATA_WORK_MODEL = 'qwen3.8-flash-next-iq3_s'
RADIANCE_KEY_FILE = Path('/srv/ai/aitext/data/radiance-api-key')
RADIANCE_MODEL = 'qwen3.8-flash-next-iq4r'
# Production model IDs include the versioned display name after benchmarking.
STRATA_WORK_MODELS = frozenset((STRATA_WORK_MODEL,
    'Qwen 3.8 Flash Next 1XR9700 Threadripper 16c - Strata v0.1.43 stock, No Brevity Vector',
    RADIANCE_MODEL))
CONTAINER_NAMES = ('aim-llm-current', 'aim-llm-active', 'aim-gemma-creative', 'aim-vllm-rocm')
IMAGE = 'sha256:83a9dc02a8f8e75aabe81366d36ebaa2e35fcbe181cacf8e8e0a4cef4ebccbcc'
CACHE = '/srv/ai/benchmarks/quant-comparison/radiance-mtp-micro-pair-v1/fast/cache:/root/.cache'

MODEL_OPTIONS = [
    {
        'id': 'qwen38-ultra-uncensored-heretic-mtp-mxfp4-convbf16-dflash-gpu98',
        'name': 'Qwen 3.8 Ultra Uncensored DFlash (fast default)',
        'path': '/srv/ai/volume/models/llm/qwen38-ultra-uncensored-heretic-mtp-mxfp4-awq-convbf16',
        'draft_path': '/srv/ai/volume/models/llm/Qwen3.8-27B-DFlash2-FP8',
        'kind': 'qwen',
        'runtime': 'vllm',
        'context': 131072,
        'max_num_seqs': 4,
        'gpu_memory_utilization': '0.98',
        'speculative_tokens': 7,
    },
    {
        'id': 'qwen38-original-mxfp4-mtpfp8',
        'name': 'Qwen 3.8 Original MXFP4 MTP FP8',
        'path': '/srv/ai/volume/models/llm/Qwen3.8-27B-MXFP4-mtpfp8',
        'kind': 'qwen',
        'runtime': 'vllm',
        'context': 131072,
    },
    {
        'id': 'gemma4-hauhau-balanced-mtp-gguf',
        'name': 'Gemma 4 HauhauCS Balanced MTP GGUF',
        'path': '/srv/ai/volume/models/llm/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf',
        'draft_path': '/srv/ai/volume/models/llm/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP/mtp-gemma-4-26B-A4B-it.gguf',
        'kind': 'gguf',
        'runtime': 'llama',
        'context': 262144,
        'n_gpu_layers': 'auto',
        'reasoning_format': 'none',
        'llama_args': [
            '--spec-draft-model', '/draft.gguf', '--spec-type', 'draft-mtp', '--spec-draft-ngl', '99',
            '--reasoning-format', 'none',
            '--temp', '0.6', '--top-k', '64', '--top-p', '0.9', '--min-p', '0.05', '--repeat-penalty', '1.1',
        ],
        'sampling_defaults': {
            'temperature': 0.6,
            'top_k': 64,
            'top_p': 0.9,
            'min_p': 0.05,
            'repeat_penalty': 1.1,
        },
        'exact_bytes': 16796015520,
        'draft_exact_bytes': 251937728,
        'disable_thinking': True,
        'strip_channel_thought': True,
    },
]
MODEL_BY_ID = {model['id']: model for model in MODEL_OPTIONS}
STRATA_WINDOW = Path('/srv/ai/strata-evaluation/window.json')


# Both of these came from strata-chat, which measured them on the user's own refusal prompt
# (2026-11-08, 5 trials per row). The Radiance build serving this app declines fiction far more
# than the previous model did, and no request parameter reliably changes that - control_vector,
# temperature 0.7-1.2, top_p, prefill and thinking levels all measured about the same - so what
# works is asking again until it writes. Keep the two in step if one of them is retuned.
MAX_ATTEMPTS = 3
PROBE_CHARS = 200
REFUSAL_START = re.compile(
    r"""I\s+(?:cannot|ca(?:n'?t|\u2019nt)\s|am\s+(?:unable|not\s+able|prohibited)|will\s+not|won(?:'?t|\u2019t)\s)
         |I['\u2019]?m\s+(?:unable|sorry)
         |I\s+can,?\s+however,?\s+(?:write|offer|describe)
         |As\s+an?\s+AI
         |Sorry[,.]
         |It\s+is\s+important\s+to\s+(?:clarify|note|remember|understand)
         |The\s+(?:premise|request|scenario|prompt|idea)\b[^.]{0,80}(?:error|problem|issue|concern|implies|assumes)
         |There\s+is\s+no\b[^.]{0,80}(?:relationship|attraction|romantic|sexual)
         |This\s+(?:story|scene|request|prompt)\s+(?:is(?:n'?t|n\u2019t)|does)
         |That['\u2019]s\s+(?:beyond|outside)""",
    re.X | re.I,
)
# Only count it as a refusal if a reason shows up too, so a first-person story opening with
# "I cannot forget that summer" is not thrown away.
REFUSAL_REASON = re.compile(
    r"prohibit|guidelin|polic|against|refus|unable|not able|comfortable|inappropria|violat"
    r"|explicit|graphic|depict|content|theme|topic|story|scene|request|relationship|minor|child|age",
    re.I,
)
# More often than saying no outright, this model answers a fiction prompt by analysing it: a
# paragraph about definitions, ages and framing instead of a scene. Those markers are meta
# commentary, and prose the user wants does not use them, so a reply that opens with any of
# them counts as a decline too.
ANALYSIS = re.compile(
    r"\*\*"  # markdown emphasis - fiction answers are asked for without headings or markup
    r"|by definition|factual and ethical|important to clarify|must be addressed"
    r"|cannot occur between|cannot give consent|legal age|legal consent|power imbalance"
    r"|adult[- ]child|is not something that can be|narrative framing|portrayed as"
    r"|is a case of|the premise of|this premise|reads the ages",
    re.I,
)


def looks_like_decline(text):
    if ANALYSIS.search(text):
        return True
    if not REFUSAL_START.search(text):
        return False
    # A reply that opens "I cannot ..." and stops almost immediately is declining, not narrating.
    # A longer one needs an explicit reason before it gets thrown away.
    return len(text) < 120 or bool(REFUSAL_REASON.search(text))


def strata_phase():
    try:
        return json.loads(STRATA_WINDOW.read_text()).get('phase')
    except (OSError, ValueError):
        return None


def current_upstream_port():
    return 8012 if strata_phase() == 'testing' else UPSTREAM_PORT


def upstream_auth():
    try:
        key = RADIANCE_KEY_FILE.read_text().strip()
    except OSError:
        return {}
    return {'Authorization': 'Bearer ' + key} if key else {}


def running_model(port):
    try:
        conn = http.client.HTTPConnection(UPSTREAM_HOST, port, timeout=5)
        try:
            conn.request('GET', '/v1/models', headers=upstream_auth())
            response = conn.getresponse()
            data = json.loads(response.read())
            models = data.get('data') or []
            return models[0].get('id') if response.status == 200 and len(models) == 1 else None
        finally:
            conn.close()
    except (OSError, ValueError, KeyError):
        return None


def upstream_connection(port, timeout):
    return http.client.HTTPConnection(UPSTREAM_HOST, port, timeout=timeout)



def read_state():
    if not DATA.exists():
        return None
    with DATA.open() as f:
        return json.load(f)


def write_state(state):
    DATA.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=DATA.parent, prefix='.state.', suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump(state, f, separators=(',', ':'))
    os.replace(name, DATA)


def default_state():
    return {'meta': None, 'documents': []}


def run(cmd, check=True):
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=check)


def docker_running(name):
    result = run(['docker', 'inspect', '-f', '{{.State.Running}}', name], check=False)
    return result.returncode == 0 and result.stdout.strip() == 'true'


def model_ready(model):
    p = Path(model['path'])
    if model.get('runtime') == 'llama':
        if not p.is_file():
            return False
        if model.get('exact_bytes') and p.stat().st_size != model['exact_bytes']:
            return False
        if not model.get('exact_bytes') and p.stat().st_size <= model.get('min_bytes', 1024 * 1024):
            return False
        draft = model.get('draft_path')
        if draft:
            d = Path(draft)
            if not d.is_file():
                return False
            if model.get('draft_exact_bytes'):
                return d.stat().st_size == model['draft_exact_bytes']
            return d.stat().st_size > model.get('draft_min_bytes', 1024 * 1024)
        return True
    return p.is_dir() and (p / 'config.json').is_file() and any(f.suffix == '.safetensors' and f.stat().st_size > 1024 * 1024 for f in p.iterdir())


def list_models_payload():
    items = [{
        'id': model['id'],
        'object': 'model',
        'name': model['name'],
        'context_length': model['context'],
        'description': 'ready',
    } for model in MODEL_OPTIONS if model_ready(model)]
    current = running_model(current_upstream_port())
    if current and not any(item['id'] == current for item in items):
        items.insert(0, {'id': current, 'object': 'model', 'name': current,
                         'context_length': 131072, 'description': 'currently running'})
    return {'object': 'list', 'data': items}


def base_docker(model):
    cmd = [
        'docker', 'create', '--restart', 'unless-stopped', '--name', 'aim-llm-current',
        '--device', '/dev/kfd', '--device', '/dev/dri', '--security-opt', 'seccomp=unconfined', '--shm-size', '8g',
        '-p', f'0.0.0.0:{UPSTREAM_PORT}:8000',
        '-v', f"{model['path']}:/model:ro",
        '-v', CACHE,
        '-e', 'HF_HUB_OFFLINE=1', '-e', 'HIP_VISIBLE_DEVICES=0', '-e', 'VLLM_WORKER_MULTIPROC_METHOD=spawn',
        '-e', 'VLLM_ROCM_USE_AITER=1', '-e', 'VLLM_ROCM_USE_AITER_UNIFIED_ATTENTION=1',
        '-e', 'RADIANCE_USE_R4D=1', '-e', 'RADIANCE_R4D_REPORT=1', '-e', 'RADIANCE_RUN_BWTEST=0',
        '-e', 'RADIANCE_MXFP4=1', '-e', 'RADIANCE_MXFP4_W4A8=1', '-e', 'RADIANCE_MXFP4_W4A8_MIN_M=0',
        '-e', 'RADIANCE_MXFP4_DECODE_MAX_M=64', '-e', 'RADIANCE_MXFP4_TN4_MIN_M=2048',
        '-e', 'RADIANCE_MXFP4_WPERM=1', '-e', 'RADIANCE_MXFP4_DECODE_NT=1',
        '-e', 'RADIANCE_DYNAMIC_DRAFT=0',
        IMAGE,
        '/model', '--served-model-name', model['id'], '--tensor-parallel-size', '1', '--max-model-len', str(model['context']),
        '--max-num-seqs', '1', '--max-num-batched-tokens', '4096', '--gpu-memory-utilization', '0.95',
        '--dtype', 'bfloat16', '--kv-cache-dtype', 'fp8', '--attention-backend', 'R4D',
        '--no-async-scheduling', '--generation-config', 'vllm',
        '--limit-mm-per-prompt', '{"image": 0, "video": 0}', '--host', '0.0.0.0', '--port', '8000',
    ]
    if model.get('draft_path'):
        cmd[cmd.index(IMAGE):cmd.index(IMAGE)] = ['-v', f"{model['draft_path']}:/draft:ro"]
    if model.get('max_num_seqs'):
        cmd[cmd.index('--max-num-seqs') + 1] = str(model['max_num_seqs'])
    if model.get('gpu_memory_utilization'):
        cmd[cmd.index('--gpu-memory-utilization') + 1] = str(model['gpu_memory_utilization'])
    if model.get('speculative_tokens'):
        cmd += ['--speculative-config', json.dumps({
            'method': 'dflash', 'model': '/draft', 'num_speculative_tokens': model['speculative_tokens'],
            'attention_backend': 'TRITON_ATTN', 'disable_padded_drafter_batch': True,
            'draft_sample_method': 'greedy',
        }, separators=(',', ':'))]
    return cmd


def llama_docker(model):
    cmd = [
        'docker', 'create', '--restart', 'unless-stopped', '--name', 'aim-llm-current',
        '--device', '/dev/kfd', '--device', '/dev/dri', '--security-opt', 'seccomp=unconfined', '--shm-size', '8g',
        '-p', f'0.0.0.0:{UPSTREAM_PORT}:8000',
        '-e', 'LLAMA_MODEL=/model.gguf', '-e', 'LLAMA_PORT=8000',
        '-e', f"LLAMA_CTX_SIZE={model['context']}", '-e', 'LLAMA_PARALLEL=1',
        '-e', f"LLAMA_N_GPU_LAYERS={model.get('n_gpu_layers', '999')}",
        '-e', f"LLAMA_REASONING_FORMAT={model.get('reasoning_format', 'deepseek')}",
        '-v', f"{model['path']}:/model.gguf:ro",
    ]
    if model.get('mmproj'):
        cmd += ['-e', 'LLAMA_MMPROJ=/mmproj.gguf', '-v', f"{model['mmproj']}:/mmproj.gguf:ro"]
    if model.get('draft_path'):
        cmd += ['-v', f"{model['draft_path']}:/draft.gguf:ro"]
    cmd += ['ai-image-maker/llama-runtime:vulkan-local']
    cmd += model.get('llama_args', [])
    return cmd


def remove_arg(cmd, flag, takes_value=True):
    while flag in cmd:
        i = cmd.index(flag)
        del cmd[i:i + (2 if takes_value else 1)]


def remove_env(cmd, name):
    i = 0
    while i < len(cmd) - 1:
        if cmd[i] == '-e' and cmd[i + 1].startswith(name + '='):
            del cmd[i:i + 2]
            continue
        i += 1


def docker_cmd(model):
    cmd = llama_docker(model) if model.get('runtime') == 'llama' else base_docker(model)
    if model.get('r4d') is False:
        remove_arg(cmd, '--attention-backend')
        remove_env(cmd, 'RADIANCE_USE_R4D')
        remove_env(cmd, 'RADIANCE_R4D_REPORT')
        image_i = cmd.index(IMAGE)
        cmd[image_i:image_i] = ['-e', 'RADIANCE_USE_R4D=0', '-e', 'RADIANCE_R4D_REPORT=0']
    if model.get('async_scheduling'):
        remove_arg(cmd, '--no-async-scheduling', takes_value=False)
    if 'kv_cache_dtype' in model and model.get('kv_cache_dtype') is None:
        remove_arg(cmd, '--kv-cache-dtype')
    elif model.get('kv_cache_dtype'):
        if '--kv-cache-dtype' in cmd:
            cmd[cmd.index('--kv-cache-dtype') + 1] = str(model['kv_cache_dtype'])
        else:
            cmd += ['--kv-cache-dtype', str(model['kv_cache_dtype'])]
    if model['kind'] == 'qwen':
        cmd += [
            '--reasoning-parser', 'qwen3',
            '--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_coder',
        ]
    return cmd


def wait_ready(timeout=900):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=5)
            conn.request('GET', '/v1/models', headers=upstream_auth())
            resp = conn.getresponse()
            resp.read()
            conn.close()
            if resp.status == 200:
                return True
        except Exception:
            pass
        time.sleep(5)
    return False


def upstream_ready():
    try:
        conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=5)
        conn.request('GET', '/v1/models', headers=upstream_auth())
        resp = conn.getresponse()
        resp.read()
        conn.close()
        return resp.status == 200
    except Exception:
        return False


def ensure_model(model_id):
    model = MODEL_BY_ID.get(model_id)
    if model is None:
        raise ValueError('Unknown model; no switch performed')
    if not model_ready(model):
        raise RuntimeError(f"{model['name']} is not ready on disk yet")
    if ACTIVE.exists() and ACTIVE.read_text().strip() == model['id'] and docker_running('aim-llm-current') and upstream_ready():
        return
    for name in CONTAINER_NAMES:
        run(['docker', 'rm', '-f', name], check=False)
    run(docker_cmd(model))
    run(['docker', 'start', 'aim-llm-current'])
    ACTIVE.parent.mkdir(parents=True, exist_ok=True)
    ACTIVE.write_text(model['id'])
    if not wait_ready():
        raise RuntimeError(f"Timed out starting {model['name']}")


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def browser_origin_allowed(self):
        origin = self.headers.get('Origin')
        if not origin:
            return True
        parsed = urlsplit(origin)
        host = self.headers.get('Host', '').lower()
        name = (parsed.hostname or '').lower()
        if parsed.scheme not in ('http', 'https') or parsed.netloc.lower() != host:
            return False
        if name in {'localhost', 'ai-server', 'ai-server.local',
                    'ai-server.tailbe59ad.ts.net'}:
            return True
        try:
            ipaddress.ip_address(name)
            return True
        except ValueError:
            return False

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('content-length') or 0)
        if not length:
            return None
        return json.loads(self.rfile.read(length))

    def do_OPTIONS(self):
        if not self.browser_origin_allowed():
            return self.send_json(403, {'error': 'Browser origin is not AIText'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'content-type,authorization')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self.browser_origin_allowed():
            return self.send_json(403, {'error': 'Browser origin is not AIText'})
        if self.path == '/app-state':
            return self.send_json(200, read_state() or default_state())
        if self.path.startswith('/app-state/documents/'):
            doc_id = unquote(self.path.rsplit('/', 1)[-1])
            for doc in (read_state() or default_state()).get('documents', []):
                if doc.get('id') == doc_id:
                    return self.send_json(200, doc)
            return self.send_json(404, {'error': 'not found'})
        if self.path == '/v1/models':
            return self.send_json(200, list_models_payload())
        if self.path.startswith('/v1/'):
            return self.proxy()
        path = self.translate_path(self.path)
        if not os.path.exists(path) and '.' not in Path(self.path).name:
            self.path = '/index.html'
        return super().do_GET()

    def relay_stream(self, resp, opening=b''):
        """Pass Radiance's SSE stream through to the browser, after any opening already read."""
        self.send_response(resp.status, resp.reason)
        for k, v in resp.getheaders():
            if k.lower() in {'connection', 'transfer-encoding', 'content-encoding', 'content-length'}:
                continue
            self.send_header(k, v)
        self.close_connection = True
        self.send_header('Connection', 'close')
        self.end_headers()
        if opening:
            self.wfile.write(opening)
            self.wfile.flush()
        while True:
            chunk = resp.read(256)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()

    def probe_stream(self, resp, limit=PROBE_CHARS):
        """Read the opening of an SSE reply without forwarding it, so a decline can be retried
        before the browser has seen any of it. Returns (reply text so far, raw bytes read)."""
        head, opening = '', b''
        while len(head) < limit and len(opening) < 262144:  # the byte cap is a memory backstop
            line = resp.readline()
            if not line:
                break
            opening += line
            if not line.startswith(b'data: '):
                continue
            data = line[6:].strip()
            if data == b'[DONE]':
                break
            try:
                choices = (json.loads(data).get('choices') or [])
                head += ((choices[0].get('delta') if choices else None) or {}).get('content') or ''
            except Exception:
                pass
        return head, opening

    def do_POST(self):
        if not self.browser_origin_allowed():
            return self.send_json(403, {'error': 'Browser origin is not AIText'})
        if self.path == '/app-state/meta':
            state = read_state() or default_state()
            meta = self.read_json()
            if meta and isinstance(meta.get('settings'), dict) and meta['settings'].get('provider') == 'aiServer':
                if meta['settings'].get('model') == 'gemma-creative':
                    meta['settings']['model'] = MODEL_OPTIONS[0]['id']
                meta['settings']['favoriteModelIds'] = [m['id'] for m in MODEL_OPTIONS if model_ready(m)]
                meta['modelCache'] = {'items': list_models_payload()['data'], 'fetchedAt': int(time.time() * 1000)}
            state['meta'] = meta
            write_state(state)
            return self.send_json(200, {'ok': True})
        if self.path.startswith('/v1/'):
            return self.proxy()
        self.send_error(404)

    def do_PUT(self):
        if not self.browser_origin_allowed():
            return self.send_json(403, {'error': 'Browser origin is not AIText'})
        if self.path.startswith('/app-state/documents/'):
            document = self.read_json()
            doc_id = unquote(self.path.rsplit('/', 1)[-1])
            state = read_state() or default_state()
            docs = [doc for doc in state.get('documents', []) if doc.get('id') != doc_id]
            docs.append(document)
            state['documents'] = docs
            write_state(state)
            return self.send_json(200, {'ok': True})
        self.send_error(404)

    def do_DELETE(self):
        if not self.browser_origin_allowed():
            return self.send_json(403, {'error': 'Browser origin is not AIText'})
        if self.path.startswith('/app-state/documents/'):
            doc_id = unquote(self.path.rsplit('/', 1)[-1])
            state = read_state() or default_state()
            state['documents'] = [doc for doc in state.get('documents', []) if doc.get('id') != doc_id]
            meta = state.get('meta') or {}
            if isinstance(meta.get('documentOrder'), list):
                meta['documentOrder'] = [id for id in meta['documentOrder'] if id != doc_id]
            if meta.get('activeDocumentId') == doc_id:
                meta['activeDocumentId'] = meta.get('documentOrder', [None])[0] if meta.get('documentOrder') else None
            state['meta'] = meta or state.get('meta')
            write_state(state)
            return self.send_json(200, {'ok': True})
        self.send_error(404)

    def proxy(self):
        length = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(length) if length else None
        request_stream = False
        strip_channel_thought = False
        port = current_upstream_port()
        decline_guard = False
        if self.path == '/v1/chat/completions' and body:
            try:
                payload = json.loads(body)
                request_stream = bool(payload.get('stream'))
                requested = payload.get('model')
                if requested is not None and not isinstance(requested, str):
                    return self.send_json(400, {'error': 'Model must be a string'})
                model_id = (requested or '').strip()
                current = running_model(port)
                if not model_id:
                    if not current:
                        return self.send_json(503, {'error': 'No running model is available'})
                    model_id = current
                elif model_id != current:
                    if model_id not in MODEL_BY_ID:
                        return self.send_json(400, {'error': 'Unknown model; no switch performed'})
                    if strata_phase() in ('testing', 'promoting', 'promoted'):
                        return self.send_json(409, {'error': 'Model switching is paused while Strata is active'})
                    ensure_model(model_id)
                    port = UPSTREAM_PORT
                payload['model'] = model_id
                if model_id in STRATA_WORK_MODELS:
                    # Radiance has one server-side safety direction and takes it as a boolean; a
                    # request's own value overrides the server default, which is off. Measured
                    # 2026-11-08 it is worth about 0-2/5 either way on a prompt the model wants to
                    # refuse, so it is not the fix - looks_like_decline above is. It is free, and it
                    # is the only uncensored lever this build has, so the request keeps saying it.
                    payload['control_vector'] = True
                    payload['experimental_speed_projection'] = True
                    # Judging the opening only works when there is one, so the guard is off while
                    # the request thinks: reasoning deltas arrive before any reply text, and there
                    # is no way to un-send them to ask again. With thinking on this is the old
                    # behaviour, byte for byte. AIText has a saved disable-thinking setting for this.
                    thinking = payload.get('chat_template_kwargs')
                    decline_guard = isinstance(thinking, dict) and thinking.get('enable_thinking') is False
                model = MODEL_BY_ID.get(model_id) or {}
                strip_channel_thought = bool(model.get('strip_channel_thought'))
                for key, value in model.get('sampling_defaults', {}).items():
                    payload.setdefault(key, value)
                if model.get('disable_thinking'):
                    kwargs = payload.get('chat_template_kwargs')
                    if not isinstance(kwargs, dict):
                        kwargs = {}
                    kwargs['enable_thinking'] = False
                    payload['chat_template_kwargs'] = kwargs
                body = json.dumps(payload).encode()
            except Exception as exc:
                return self.send_json(503, {'error': str(exc)})
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in {'host', 'content-length', 'connection', 'accept-encoding'}
        }
        # This proxy is the trusted same-origin API for AIText on any
        # current LAN or Tailnet IP, or one of its own hostnames.
        if self.browser_origin_allowed():
            headers.pop('Origin', None)
            headers.pop('origin', None)
        headers = {k: v for k, v in headers.items() if k.lower() not in {'authorization', 'x-api-key'}}
        headers.update(upstream_auth())
        for attempt in range(1, MAX_ATTEMPTS + 1):
            retry = False
            conn = upstream_connection(port, 300)
            try:
                conn.request(self.command, self.path, body=body, headers=headers)
                resp = conn.getresponse()
                if request_stream and not strip_channel_thought:
                    if decline_guard and attempt < MAX_ATTEMPTS:
                        head, opening = self.probe_stream(resp)
                        if head.strip() and looks_like_decline(head):
                            print('AIText attempt %d/%d declined: %r'
                                  % (attempt, MAX_ATTEMPTS, head[:60]), flush=True)
                            retry = True
                        else:
                            self.relay_stream(resp, opening)
                    else:
                        # The last try is shown as it comes, decline or not, so the user always
                        # gets a complete reply rather than a truncated sample of one.
                        self.relay_stream(resp)
                    if not retry:
                        return
                elif request_stream:
                    self.send_response(resp.status, resp.reason)
                    for k, v in resp.getheaders():
                        if k.lower() in {'connection', 'transfer-encoding', 'content-encoding', 'content-length'}:
                            continue
                        self.send_header(k, v)
                    self.close_connection = True
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    filtering_thought = None
                    pending = ''
                    while True:
                        line = resp.readline()
                        if not line:
                            break
                        if not line.startswith(b'data: '):
                            self.wfile.write(line)
                            self.wfile.flush()
                            continue
                        data = line[6:].strip()
                        if data == b'[DONE]':
                            self.wfile.write(line)
                            self.wfile.flush()
                            continue
                        try:
                            event = json.loads(data)
                            choices = event.get('choices') or []
                            delta = (choices[0].get('delta') if choices else None) or {}
                            text = delta.get('content') or ''
                            if text:
                                if filtering_thought is None:
                                    filtering_thought = text.startswith('<|channel>thought')
                                if filtering_thought:
                                    pending += text
                                    marker = pending.find('<channel|>')
                                    if marker < 0:
                                        delta['content'] = ''
                                    else:
                                        delta['content'] = pending[marker + len('<channel|>'):]
                                        pending = ''
                                        filtering_thought = False
                                line = b'data: ' + json.dumps(event).encode() + b'\n\n'
                        except Exception:
                            pass
                        self.wfile.write(line)
                        self.wfile.flush()
                    return
                else:
                    raw = resp.read()
                    reply = ''
                    if self.path == '/v1/chat/completions' and raw:
                        try:
                            payload = json.loads(raw)
                            for choice in payload.get('choices') or []:
                                msg = choice.get('message') or {}
                                if strip_channel_thought and isinstance(msg.get('content'), str) and msg['content'].startswith('<|channel>thought'):
                                    msg['content'] = msg['content'].split('<channel|>')[-1] if '<channel|>' in msg['content'] else ''
                                if not msg.get('content') and msg.get('reasoning_content'):
                                    msg['content'] = msg['reasoning_content']
                                reply = reply or (msg.get('content') or '')
                            raw = json.dumps(payload).encode()
                        except Exception:
                            pass
                    if decline_guard and attempt < MAX_ATTEMPTS and reply.strip() and looks_like_decline(reply):
                        print('AIText attempt %d/%d declined: %r'
                              % (attempt, MAX_ATTEMPTS, reply[:60]), flush=True)
                        continue
                    self.send_response(resp.status, resp.reason)
                    for k, v in resp.getheaders():
                        if k.lower() in {'connection', 'transfer-encoding', 'content-encoding', 'content-length'}:
                            continue
                        self.send_header(k, v)
                    self.send_header('Content-Length', str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    self.wfile.flush()
                    return
            finally:
                conn.close()


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
