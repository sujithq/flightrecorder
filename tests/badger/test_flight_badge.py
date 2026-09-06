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
        for expected in (SUMMARY, dict(SUMMARY, version=2, tokens=None, estimatedCost=None)):
            with self.subTest(version=expected["version"]):
                payload = dict(expected, input="private", output="private", attributes={"hidden": "private"})
                self.assertEqual(badge.decode_frame(json.dumps(payload)), expected)

    def test_invalid_frames_are_rejected(self):
        for patch in ({"version": 0}, {"version": 3}, {"version": True}, {"version": "2"},
                      {"version": None}, {"runId": "bad"}, {"status": "Other"}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                badge.decode_frame(json.dumps(dict(SUMMARY, **patch)))
        for payload in ("not JSON", "[]", "null"):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                badge.decode_frame(payload)

    def test_reported_zero_positive_and_boundary_metrics_are_preserved(self):
        for version in (1, 2):
            for metrics in (
                {"eventCount": 0, "tokens": 0, "durationSeconds": 0, "estimatedCost": 0},
                {"eventCount": 11, "tokens": 6990, "durationSeconds": 14.7, "estimatedCost": 0.0164},
                {field: 9007199254740991 for field in ("eventCount", "tokens", "durationSeconds", "estimatedCost")},
            ):
                with self.subTest(version=version, metrics=metrics):
                    expected = dict(SUMMARY, version=version, **metrics)
                    self.assertEqual(badge.decode_frame(json.dumps(expected)), expected)

    def test_only_version_two_allows_null_usage_metrics(self):
        for usage in ({"tokens": None}, {"estimatedCost": None}, {"tokens": None, "estimatedCost": None}):
            with self.subTest(usage=usage):
                expected = dict(SUMMARY, version=2, **usage)
                self.assertEqual(badge.decode_frame(json.dumps(expected)), expected)
                with self.assertRaises(ValueError):
                    badge.decode_frame(json.dumps(dict(SUMMARY, **usage)))

    def test_metrics_are_required_and_not_coerced(self):
        for version in (1, 2):
            for field in ("eventCount", "tokens", "durationSeconds", "estimatedCost"):
                for value in (-1, float("nan"), float("inf"), -float("inf"),
                              9007199254740992, True, False, "0", "", [], {}):
                    with self.subTest(version=version, field=field, value=value), self.assertRaises(ValueError):
                        badge.decode_frame(json.dumps(dict(SUMMARY, version=version, **{field: value})))
                missing = dict(SUMMARY, version=version)
                del missing[field]
                with self.subTest(version=version, missing=field), self.assertRaises(ValueError):
                    badge.decode_frame(json.dumps(missing))
                if version == 1 or field in ("eventCount", "durationSeconds"):
                    with self.subTest(version=version, null=field), self.assertRaises(ValueError):
                        badge.decode_frame(json.dumps(dict(SUMMARY, version=version, **{field: None})))
            for field in ("eventCount", "tokens"):
                with self.subTest(version=version, fractional=field), self.assertRaises(ValueError):
                    badge.decode_frame(json.dumps(dict(SUMMARY, version=version, **{field: 1.5})))

    def test_fragmented_frames_and_overflow_recover(self):
        self.assertEqual(badge.MAX_FRAME, 1024)
        for expected in (SUMMARY, dict(SUMMARY, version=2, tokens=None, estimatedCost=None)):
            with self.subTest(version=expected["version"]):
                frames = badge.FrameBuffer()
                message = json.dumps(expected) + "\r\n"
                results = [frames.feed(character) for character in message]
                self.assertEqual(results[-1], expected)
                for character in "x" * 1500:
                    frames.feed(character)
                    self.assertLessEqual(len(frames.buffer), badge.MAX_FRAME)
                with self.assertRaises(ValueError):
                    frames.feed("\n")
                results = [frames.feed(character) for character in message]
                self.assertEqual(results[-1], expected)
                with self.assertRaises(ValueError):
                    for character in json.dumps(dict(expected, version=3)) + "\n":
                        frames.feed(character)
                results = [frames.feed(character) for character in message]
                self.assertEqual(results[-1], expected)

    def test_ascii_and_text_bounds(self):
        for version in (1, 2):
            with self.subTest(version=version):
                result = badge.decode_frame(json.dumps(dict(SUMMARY, version=version, agent="A\n\u0003" * 30, alert="B" * 100)))
                self.assertEqual(len(result["agent"]), 28)
                self.assertEqual(len(result["alert"]), 64)
                self.assertNotIn("\n", result["agent"])

    def test_unknown_usage_renders_without_hiding_reported_metrics(self):
        display = Display()
        for tokens, cost, token_text, cost_text in (
            (None, None, "?", "?"),
            (None, 0, "?", "0.0000"),
            (0, None, "0", "?"),
            (None, 0.0164, "?", "0.0164"),
            (6990, None, "6990", "?"),
        ):
            with self.subTest(tokens=tokens, cost=cost):
                summary = badge.decode_frame(json.dumps(dict(SUMMARY, version=2, tokens=tokens, estimatedCost=cost)))
                badge.render(display, summary)
                lines = [line[0] for line in display.lines]
                self.assertIn("11 events   %s tokens" % token_text, lines)
                self.assertIn("14.7s   USD %s" % cost_text, lines)

    def test_zero_and_positive_usage_remain_visible_in_both_versions(self):
        display = Display()
        for version in (1, 2):
            for tokens, cost, token_text, cost_text in ((0, 0, "0", "0.0000"), (6990, 0.0164, "6990", "0.0164")):
                with self.subTest(version=version, tokens=tokens, cost=cost):
                    summary = badge.decode_frame(json.dumps(dict(SUMMARY, version=version, tokens=tokens, estimatedCost=cost)))
                    badge.render(display, summary)
                    lines = [line[0] for line in display.lines]
                    self.assertIn("11 events   %s tokens" % token_text, lines)
                    self.assertIn("14.7s   USD %s" % cost_text, lines)

    def test_positive_cost_below_display_precision_is_not_shown_as_zero(self):
        display = Display()
        for version in (1, 2):
            for cost, expected in ((1e-12, "<0.0001"), (0.000049, "<0.0001"),
                                   (0.00009999, "<0.0001"), (0.0001, "0.0001")):
                with self.subTest(version=version, cost=cost):
                    summary = badge.decode_frame(json.dumps(dict(SUMMARY, version=version, estimatedCost=cost)))
                    badge.render(display, summary)
                    self.assertIn("14.7s   USD " + expected, [line[0] for line in display.lines])
                    for text, left, top, width, scale in display.lines:
                        self.assertLessEqual(display.measure_text(text, scale), width)

    def test_all_statuses_and_long_values_fit_on_screen(self):
        display = Display()
        for status in badge.STATUSES:
            for version, tokens, cost in (
                (1, 9007199254740991, 9007199254740991),
                (2, 9007199254740991, 9007199254740991),
                (2, None, None),
                (2, 0, 0),
                (2, None, 9007199254740991),
                (2, 9007199254740991, None),
            ):
                with self.subTest(status=status, version=version, tokens=tokens, cost=cost):
                    summary = dict(SUMMARY, version=version, status=status, agent="W" * 28, alert="W" * 64,
                                   tokens=tokens, estimatedCost=cost)
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