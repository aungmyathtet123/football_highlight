"""Separate the first pass/cross release from the scorer's later contact."""

import math


def action_clock(brief, start, end):
    """Discard stale or collapsed source timestamps after an interval change."""
    duration = max(.001, end - start)
    defaults = (duration * .34, duration * .38, duration * .50, duration * .68)
    fields = ("contactTime", "flightStartTime", "handoffTime", "payoffStartTime")
    values = []
    for field, fallback in zip(fields, defaults):
        value = brief.get(field)
        values.append(min(duration, max(0., value - start))
                      if isinstance(value, (int, float)) and math.isfinite(value)
                      and start <= value <= end else fallback)
    contact, flight, handoff, payoff = values
    if duration >= 1.5 and (payoff <= min(contact, flight) + .08
                            or payoff < .15 * duration
                            or contact > .90 * duration):
        contact, flight, handoff, payoff = defaults
    handoff = max(flight, handoff)
    payoff = max(handoff + min(.10, duration * .06), payoff)
    payoff = min(duration, payoff)
    return contact, flight, handoff, payoff


def action_phase(elapsed, contact_time, flight_time, payoff_time):
    if elapsed >= payoff_time:
        return 'payoff'
    if flight_time < contact_time:
        if elapsed < flight_time:
            return 'setup'
        # Observe the final receiving/finishing touch without holding the
        # earlier passer throughout the cross. Neither time invents a position.
        if contact_time - .15 <= elapsed <= contact_time + .12:
            return 'contact'
        return 'flight'
    if elapsed < contact_time:
        return 'setup'
    if elapsed < flight_time:
        return 'contact'
    return 'flight'
