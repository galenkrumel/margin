"""Margin statistics -- the one shared definition of the interval math.

  python stats.py    # selfcheck
"""

import math

Z = 1.96  # 95%


def wilson(k, n, z=Z):
    """Wilson score interval. Same formula as analyze.py:12, which produced
    the measured numbers."""
    if n == 0:
        return 0.0, 0.0, 1.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, max(0.0, c - h), min(1.0, c + h)


def n_for_width(p, w, z=Z):
    """Queries needed for a 95% CI of width w at rate p (normal approx:
    n ~= 4 z^2 p(1-p) / w^2 -- the price-list quote; Wilson is slightly
    narrower near p=0.5, so the quote is honest)."""
    return math.ceil(4 * z * z * p * (1 - p) / (w * w))


if __name__ == "__main__":
    # boundary case from the pitch: 0/40 refused -> Wilson honestly says up to ~8.8%
    p, lo, hi = wilson(0, 40)
    assert (p, lo) == (0.0, 0.0) and abs(hi - 0.088) < 0.002, (p, lo, hi)
    p, lo, hi = wilson(0, 120)
    assert abs(hi - 0.031) < 0.002, hi
    # own-brand job: 38/39
    p, lo, hi = wilson(38, 39)
    assert abs(p - 0.974) < 0.001 and hi <= 1.0 and lo < p < hi
    # symmetry: k and n-k mirror around 0.5
    pa, loa, hia = wilson(30, 100)
    pb, lob, hib = wilson(70, 100)
    assert abs(loa - (1 - hib)) < 1e-9 and abs(hia - (1 - lob)) < 1e-9
    # price-list sanity: +/-5pts at p=.5 needs ~384+ queries, more than +/-7
    assert n_for_width(0.5, 0.10) > 380 > n_for_width(0.5, 0.14)
    print("stats selfcheck OK")
