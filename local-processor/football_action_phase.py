"""Separate the first pass/cross release from the scorer's later contact."""


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
