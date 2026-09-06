import importlib.util
import json
from pathlib import Path
import unittest

module_path = Path(__file__).resolve().parents[2] / "integrations" / "badger2040" / "flight_badge.py"
spec = importlib.util.spec_from_file_location("flight_badge", module_path)
badge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(badge)

SUMMARY = {
    "version": 1, "runId": "11111111-2222-3333-4444-555555555555",
    "agent": "coding-agent", "status": "Blocked", "eventCount": 11, "tokens": 6990,
    "durationSeconds": 14.7, "estimatedCost": 0.0164, "alert": "Create pull request",
}


class Display:
    def __init__(self):
        self.lines = []

    def measure_text(self, text, scale):
        return len(text) * 6 * scale

    def text(self, text, left, top, width, scale):
        self.lines.append((text, left, top, width, scale))

    def set_pen(self, color):
        if color not in (0, 15):
            raise ValueError("Expected black or white")

    def clear(self):
        self.lines = []

    def rectangle(self, left, top, width, height):
        if left + width > badge.WIDTH or top + height > badge.HEIGHT:
            raise ValueError("Rectangle outside display")

    def set_font(self, font):
        if font != "bitmap8":
            raise ValueError("Expected bitmap8")


class BadgeTests(unittest.TestCase):
    def test_allowlisted_summary(self):
        payload = dict(SUMMARY, input="private", attributes={"hidden": "private"})
        self.assertEqual(badge.decode_frame(json.dumps(payload)), SUMMARY)

    def test_invalid_frames_are_rejected(self):
        for patch in ({"version": 2}, {"runId": "bad"}, {"status": "Other"},
                      {"tokens": -1}, {"eventCount": 1.5}, {"tokens": True},
                      {"durationSeconds": float("inf")}, {"estimatedCost": float("nan")}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                badge.decode_frame(json.dumps(dict(SUMMARY, **patch)))

    def test_fragmented_frames_and_overflow_recover(self):
        frames = badge.FrameBuffer()
        message = json.dumps(SUMMARY) + "\r\n"
        results = [frames.feed(character) for character in message]
        self.assertEqual(results[-1], SUMMARY)
        for character in "x" * 1500:
            frames.feed(character)
            self.assertLessEqual(len(frames.buffer), badge.MAX_FRAME)
        with self.assertRaises(ValueError):
            frames.feed("\n")
        results = [frames.feed(character) for character in message]
        self.assertEqual(results[-1], SUMMARY)

    def test_ascii_and_text_bounds(self):
        result = badge.decode_frame(json.dumps(dict(SUMMARY, agent="A\n\u0003" * 30, alert="B" * 100)))
        self.assertEqual(len(result["agent"]), 28)
        self.assertEqual(len(result["alert"]), 64)
        self.assertNotIn("\n", result["agent"])

    def test_all_statuses_and_long_values_fit_on_screen(self):
        display = Display()
        for status in badge.STATUSES:
            summary = dict(SUMMARY, status=status, agent="W" * 28, alert="W" * 64,
                           tokens=9007199254740991, estimatedCost=9007199254740991)
            badge.render(display, summary)
            self.assertEqual(len(display.lines), 7)
            previous_bottom = 0
            for text, left, top, width, scale in display.lines:
                self.assertLessEqual(display.measure_text(text, scale), width)
                self.assertLessEqual(left + width, badge.WIDTH)
                self.assertGreaterEqual(top, previous_bottom)
                previous_bottom = top + 8 * scale
                self.assertLessEqual(previous_bottom, badge.HEIGHT)

    def test_empty_state(self):
        display = Display()
        badge.render(display)
        self.assertIn("WAITING", [line[0] for line in display.lines])


if __name__ == "__main__":
    unittest.main()