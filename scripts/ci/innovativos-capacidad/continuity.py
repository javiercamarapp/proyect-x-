"""Acceptance requires uninterrupted wall-clock telemetry, including both edges."""
import math

MAX_GAP_SECONDS = 90


def gap_reason(previous_epoch, current_epoch):
    gap = current_epoch - previous_epoch
    if not math.isfinite(gap) or gap < 0:
        return 'telemetry-clock-invalid'
    if gap > MAX_GAP_SECONDS:
        return 'telemetry-gap'
    return None


def continuity(start_epoch, sample_epochs, end_epoch):
    points = [start_epoch, *sample_epochs, end_epoch]
    gaps = [right - left for left, right in zip(points, points[1:])]
    reasons = [gap_reason(left, right) for left, right in zip(points, points[1:])]
    valid = bool(sample_epochs) and not any(reasons)
    return {
        'valid': valid,
        'limit_seconds': MAX_GAP_SECONDS,
        'sample_count': len(sample_epochs),
        'max_gap_seconds': max(gaps),
        'reason': next((reason for reason in reasons if reason), None)
        if sample_epochs else 'telemetry-missing',
    }


def acceptance(summary, seconds, rate):
    return bool(
        summary['finished']['completed_full_duration']
        and summary['telemetry_continuity']['valid']
        and summary['failed_transactions'] == 0
        and summary['successful_transactions'] >= seconds * rate * .9
        and summary['p95_ms'] is not None and summary['p95_ms'] < 250
        and summary['p99_ms'] is not None and summary['p99_ms'] < 1000
        and summary['deadlocks_delta'] == 0
    )
