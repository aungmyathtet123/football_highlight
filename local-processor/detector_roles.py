"""Resolve model labels, never assume class zero means a player."""
import math

def broadcast_scale_change(previous, current):
    """Detect close-up/wide angle changes that a global colour histogram misses.

    Pitch colour stays green across a dissolve. Only reset when confident
    subject scale AND the number of visible people change substantially.
    Ordinary player motion, a slow zoom or a missing detection is not a cut.
    """
    def sizes(people):
        return sorted(p['y2']-p['y1'] for p in people
                      if p.get('confidence', 0) >= .45 and 'y1' in p and 'y2' in p)
    a,b=sizes(previous),sizes(current)
    if not a or not b:
        return False
    median=lambda values: values[len(values)//2]
    def foreground(values):
        return values[-1]>.55 and (len(values)==1 or values[-2]<values[-1]*.4)
    def action_view(values):
        return len(values)>=3 and median(values)<.25 and values[-1]<.4
    # Tiny distant people/logo false positives do not turn a clearly dominant
    # foreground body into a wide shot. A dissolve to a medium action view can
    # also retain players taller than the old .18 wide-shot cutoff.
    if foreground(a) and action_view(b) or foreground(b) and action_view(a):
        return True
    return (len(a)<=2 and median(a)>.30 and len(b)>=4 and median(b)<.18
            or len(b)<=2 and median(b)>.30 and len(a)>=4 and median(a)<.18)
def broadcast_scale_transition(history, current, timestamp, window=.65):
    """Catch a brief close-up/wide dissolve without repeatedly resetting it.

    Adjacent frames may be mixed intermediate views. Compare actual subject
    scale/count inside a bounded recent source interval, never across a cut.
    Ordinary motion and slow zoom still fail the two independent scale/count
    conditions in broadcast_scale_change.
    """
    for observation in reversed(history):
        if timestamp-observation['time']>window:
            break
        if broadcast_scale_change(observation['people'],current):
            return True
        if observation.get('cut'):
            break
    return False

def football_classes(names):
    names = dict(enumerate(names)) if isinstance(names, (list, tuple)) else names
    roles = {int(key): str(value).strip().lower().replace('_', ' ') for key, value in names.items()}
    people = [key for key, role in roles.items() if role in {'person', 'player', 'goalkeeper', 'referee'}]
    balls = [key for key, role in roles.items() if role in {'ball', 'football', 'sports ball', 'soccer ball'}]
    return roles, people, balls


def reacquisition_hint(balls, seed, seed_time, timestamp):
    """A weak native proposal may guide a detail SEARCH, never the camera.

    After a real seed, a 4-pixel moving ball can have low full-frame confidence.
    Restrict the search proposal by elapsed time, plausible speed, size and
    pitch evidence. Its coordinates are not a verified tracking observation.
    """
    if seed is None or seed_time is None or not 0 <= timestamp - seed_time <= .75:
        return None
    radius = .025 + .9 * (timestamp - seed_time)
    eligible = [ball for ball in balls
        if .04 <= ball.get('confidence', 0)
        and ball.get('pitchSupport', 0) >= .10
        and 0 < ball['x2'] - ball['x1'] <= .02
        and 0 < ball['y2'] - ball['y1'] <= .035
        and .12 <= ball['cy'] <= .97
        and math.hypot(ball['cx'] - seed[0], (ball['cy'] - seed[1]) * .6) <= radius]
    if len(eligible) != 1:
        return None  # Ambiguous boot/ball alternatives need independent search.
    return eligible[0]['cx'], eligible[0]['cy']


def touch_distance(person, ball, vertical_weight=.85):
    """Feet for normal control; observed head envelope for aerial contact."""
    if ball is None:
        return math.inf
    distance = math.hypot(person['cx'] - ball[0], (person['y2'] - ball[1]) * vertical_weight)
    if all(key in person for key in ('x1', 'x2', 'y1', 'y2')):
        height = person['y2'] - person['y1']
        if (height > 0 and person['x1'] - .012 <= ball[0] <= person['x2'] + .012
                and person['y1'] - .025 <= ball[1] <= person['y1'] + height * .18):
            head = person['y1'] + height * .08
            distance = min(distance, math.hypot(person['cx'] - ball[0], (head - ball[1]) * vertical_weight))
    return distance
