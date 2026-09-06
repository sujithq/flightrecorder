import json

WIDTH = 296
HEIGHT = 128
MAX_FRAME = 1024
STATUSES = ("Started", "Succeeded", "Failed", "Blocked", "RequiresApproval")


def ascii_text(value, limit):
    if not isinstance(value, str):
        return ""
    return "".join(character if 32 <= ord(character) <= 126 else "?" for character in value[:limit])


def metric(value, integer=False, nullable=False):
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 9007199254740991:
        raise ValueError("Invalid metric")
    if integer and value != int(value):
        raise ValueError("Expected integer")
    return value


def decode_frame(line):
    if len(line) > MAX_FRAME:
        raise ValueError("Frame too large")
    data = json.loads(line)
    if not isinstance(data, dict):
        raise ValueError("Unsupported frame")
    version = data.get("version")
    if isinstance(version, bool) or version not in (1, 2) or data.get("status") not in STATUSES:
        raise ValueError("Unsupported frame")
    if "tokens" not in data or "estimatedCost" not in data:
        raise ValueError("Missing usage metric")
    run_id = data.get("runId", "")
    if not isinstance(run_id, str) or [len(part) for part in run_id.split("-")] != [8, 4, 4, 4, 12]:
        raise ValueError("Invalid run ID")
    if any(character not in "0123456789abcdefABCDEF-" for character in run_id):
        raise ValueError("Invalid run ID")
    return {
        "version": version,
        "runId": run_id,
        "agent": ascii_text(data.get("agent"), 28),
        "status": data["status"],
        "eventCount": metric(data.get("eventCount"), True),
        "tokens": metric(data["tokens"], True, version == 2),
        "durationSeconds": metric(data.get("durationSeconds")),
        "estimatedCost": metric(data["estimatedCost"], nullable=version == 2),
        "alert": ascii_text(data.get("alert"), 64) or None,
    }


class FrameBuffer:
    def __init__(self):
        self.buffer = ""
        self.overflow = False

    def feed(self, character):
        if character == "\r":
            return None
        if character == "\n":
            line = self.buffer
            overflow = self.overflow
            self.buffer = ""
            self.overflow = False
            if overflow:
                raise ValueError("Frame too large")
            return decode_frame(line) if line else None
        if not self.overflow:
            if len(self.buffer) >= MAX_FRAME:
                self.buffer = ""
                self.overflow = True
            else:
                self.buffer += character
        return None


def fit_text(display, text, width, scale=1):
    if display.measure_text(text, scale) <= width:
        return text
    suffix = "..."
    while text and display.measure_text(text + suffix, scale) > width:
        text = text[:-1]
    return text + suffix


def draw_line(display, text, row, scale=1):
    width = WIDTH - 16
    display.text(fit_text(display, text, width, scale), 8, row, width, scale)


def render(display, summary=None):
    display.set_pen(15)
    display.clear()
    display.set_pen(0)
    display.rectangle(0, 0, WIDTH, 20)
    display.set_font("bitmap8")
    display.set_pen(15)
    draw_line(display, "AGENT FLIGHT RECORDER", 6)
    display.set_pen(0)
    if summary is None:
        draw_line(display, "WAITING", 30, 2)
        draw_line(display, "No recorded run", 62)
        return
    status = {"Started": "RUNNING", "RequiresApproval": "APPROVAL REQUIRED"}.get(summary["status"], summary["status"].upper())
    draw_line(display, status, 26, 2)
    draw_line(display, summary["agent"], 48)
    tokens = "?" if summary["tokens"] is None else summary["tokens"]
    if summary["estimatedCost"] is None:
        cost = "?"
    elif 0 < summary["estimatedCost"] < 0.0001:
        cost = "<0.0001"
    else:
        cost = "%.4f" % summary["estimatedCost"]
    draw_line(display, "%s events   %s tokens" % (summary["eventCount"], tokens), 64)
    draw_line(display, "%.1fs   USD %s" % (summary["durationSeconds"], cost), 80)
    draw_line(display, summary["alert"] or "No recorded intervention", 97)
    draw_line(display, "Run " + summary["runId"][:8], 114)