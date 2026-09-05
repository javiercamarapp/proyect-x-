"""Synthetic clocks only: no PostgreSQL, sleeps, network or production data."""
import unittest
from continuity import acceptance, continuity, gap_reason


class ContinuityTest(unittest.TestCase):
    def summary(self, samples, end=86400):
        return {
            'finished': {'completed_full_duration': True},
            'successful_transactions': 172800,
            'failed_transactions': 0,
            'p95_ms': 1, 'p99_ms': 2, 'deadlocks_delta': 0,
            'telemetry_continuity': continuity(0, samples, end),
        }

    def test_continuous_full_day_passes(self):
        self.assertTrue(acceptance(self.summary(list(range(0, 86400, 30))), 86400, 2))

    def test_internal_sleep_fails_despite_duration_volume_and_percentiles(self):
        samples = [epoch for epoch in range(0, 86400, 30) if not 300 <= epoch <= 420]
        summary = self.summary(samples)
        self.assertFalse(acceptance(summary, 86400, 2))
        self.assertEqual(summary['telemetry_continuity']['max_gap_seconds'], 180)
        self.assertEqual(summary['telemetry_continuity']['reason'], 'telemetry-gap')

    def test_sleep_after_last_sample_fails(self):
        summary = self.summary(list(range(0, 86000, 30)))
        self.assertFalse(acceptance(summary, 86400, 2))
        self.assertGreater(summary['telemetry_continuity']['max_gap_seconds'], 90)

    def test_sleep_before_first_sample_fails(self):
        self.assertFalse(acceptance(self.summary(list(range(120, 86400, 30))), 86400, 2))

    def test_clock_reversal_fails(self):
        self.assertEqual(gap_reason(100, 99), 'telemetry-clock-invalid')
        self.assertFalse(continuity(0, [30, 20], 60)['valid'])

    def test_empty_telemetry_fails(self):
        self.assertFalse(acceptance(self.summary([]), 86400, 2))

    def test_runtime_threshold_is_strict(self):
        self.assertIsNone(gap_reason(100, 190))
        self.assertEqual(gap_reason(100, 190.001), 'telemetry-gap')


if __name__ == '__main__':
    unittest.main()
