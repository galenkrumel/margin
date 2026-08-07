"""Generate the sunscreen prompt population for Margin's demo workload.

Mix per confirmed Novi knowledge: branded fan-out queries dominate (~73%),
category queries are the minority (~27%). Deterministic — rerun after edits.

Outputs:
  queries.json  — the prompt population (id, type, brand attribution, text)
  brands.json   — canonical brands + alias lists for the regex fallback scorer
"""

import json
import itertools
from collections import Counter

TARGET_BRAND = "Supergoop"

# Canonical brand -> (aliases for regex fallback, notable products)
# Aliases must be distinctive enough to avoid false matches in prose.
BRANDS = {
    "Supergoop": {
        "aliases": ["supergoop", "super goop", "unseen sunscreen", "glowscreen", "mineral sheerscreen", "play everyday"],
        "products": ["Unseen Sunscreen SPF 40", "Glowscreen", "Play Everyday Lotion SPF 50", "Mineral Sheerscreen"],
    },
    "Sun Bum": {
        "aliases": ["sun bum", "sunbum"],
        "products": ["Original SPF 50 Lotion", "Mineral SPF 30 Lotion", "Face 50 Clear Zinc"],
    },
    "Neutrogena": {
        "aliases": ["neutrogena", "ultra sheer dry-touch", "ultra sheer dry touch", "hydro boost spf"],
        "products": ["Ultra Sheer Dry-Touch SPF 55", "Hydro Boost Water Gel SPF 50", "Sheer Zinc"],
    },
    "La Roche-Posay": {
        "aliases": ["la roche-posay", "la roche posay", "anthelios"],
        "products": ["Anthelios Melt-in Milk SPF 60", "Anthelios Mineral SPF 50", "Anthelios Clear Skin"],
    },
    "EltaMD": {
        "aliases": ["eltamd", "elta md", "uv clear", "uv daily"],
        "products": ["UV Clear SPF 46", "UV Daily SPF 40", "UV Sport SPF 50"],
    },
    "CeraVe": {
        "aliases": ["cerave", "cera ve"],
        "products": ["Hydrating Mineral Sunscreen SPF 30", "AM Facial Moisturizing Lotion SPF 30"],
    },
    "Coppertone": {
        "aliases": ["coppertone"],
        "products": ["Sport SPF 50", "Pure & Simple SPF 50", "Water Babies"],
    },
    "Black Girl Sunscreen": {
        "aliases": ["black girl sunscreen", "bgs spf"],
        "products": ["Black Girl Sunscreen SPF 30", "Make It Matte SPF 45"],
    },
}

# ---------------------------------------------------------------- branded ---
# 1) Brand-level templates applied to every brand (12 x 8 = 96)
BRAND_TEMPLATES = [
    "Is {b} sunscreen actually good?",
    "Is {b} sunscreen worth the price?",
    "{b} sunscreen review — should I buy it?",
    "Is {b} sunscreen good for oily skin?",
    "Is {b} sunscreen safe for sensitive skin?",
    "Does {b} sunscreen leave a white cast on darker skin?",
    "Is {b} sunscreen reef safe?",
    "Is {b} sunscreen chemical or mineral?",
    "Is {b} sunscreen safe to use during pregnancy?",
    "Can I use {b} sunscreen on my kids?",
    "Where should I buy {b} sunscreen — is it cheaper at Target or Ulta?",
    "What's a good cheaper dupe for {b} sunscreen?",
    "Does {b} sunscreen break people out?",
    "How water resistant is {b} sunscreen really?",
    "Is {b} sunscreen good for everyday wear or just the beach?",
    "Does {b} sunscreen feel greasy?",
    "What do reviews say about {b} sunscreen?",
    "Which {b} sunscreen should I get for my face?",
    "Is {b} a reputable sunscreen brand?",
    "Does {b} sunscreen expire fast once opened?",
]

# 2) Product-specific curated queries (uneven by design — real fan-out is uneven)
PRODUCT_QUERIES = {
    "Supergoop": [
        "Is Supergoop Unseen Sunscreen good under makeup?",
        "Does Supergoop Unseen Sunscreen clog pores?",
        "Supergoop Unseen vs Glowscreen — which one for everyday?",
        "Is Supergoop Glowscreen too shiny for oily skin?",
        "Is Supergoop Play Everyday Lotion water resistant enough for the beach?",
        "Does Supergoop Mineral Sheerscreen leave a white cast?",
        "Why is Supergoop so expensive — is it actually better?",
        "Is Supergoop Unseen enough sun protection on its own at SPF 40?",
        "Can I use Supergoop Unseen as a makeup primer?",
        "Does Supergoop Glowscreen work on textured skin?",
    ],
    "Sun Bum": [
        "Is Sun Bum Original SPF 50 good for the face or just body?",
        "Does Sun Bum sunscreen smell too strong?",
        "Is Sun Bum Face 50 Clear Zinc greasy?",
        "How long does Sun Bum SPF 50 last in the water?",
        "Is Sun Bum okay for acne-prone skin?",
    ],
    "Neutrogena": [
        "Does Neutrogena Ultra Sheer Dry-Touch pill under makeup?",
        "Is Neutrogena Hydro Boost SPF 50 hydrating enough for dry skin?",
        "Is Neutrogena Sheer Zinc good for sensitive skin?",
        "Does Neutrogena Ultra Sheer sting your eyes when you sweat?",
        "Is Neutrogena sunscreen good enough or should I spend more?",
    ],
    "La Roche-Posay": [
        "Is La Roche-Posay Anthelios worth the hype?",
        "Anthelios Melt-in Milk vs Anthelios Mineral — which should I get?",
        "Is La Roche-Posay Anthelios good for rosacea?",
        "Does Anthelios Melt-in Milk feel greasy in humidity?",
        "Is La Roche-Posay Anthelios Clear Skin good for acne?",
    ],
    "EltaMD": [
        "Is EltaMD UV Clear worth it for acne-prone skin?",
        "EltaMD UV Clear vs UV Daily — which one do I need?",
        "Do dermatologists actually recommend EltaMD?",
        "Is EltaMD UV Clear okay under foundation?",
        "Is EltaMD UV Sport sweat-proof for running?",
    ],
    "CeraVe": [
        "Is CeraVe Hydrating Mineral Sunscreen good for the face?",
        "Does CeraVe AM Lotion SPF 30 count as enough sunscreen?",
        "Does CeraVe mineral sunscreen leave a white cast?",
        "Is CeraVe sunscreen non-comedogenic?",
    ],
    "Coppertone": [
        "Is Coppertone Sport good enough for a full beach day?",
        "Is Coppertone Pure & Simple safe for babies?",
        "Does Coppertone Sport rub off with sweat?",
        "Is Coppertone Water Babies actually gentle?",
    ],
    "Black Girl Sunscreen": [
        "Does Black Girl Sunscreen really leave no white cast?",
        "Is Black Girl Sunscreen SPF 30 enough for daily wear?",
        "Is Black Girl Sunscreen Make It Matte good for oily skin?",
        "Is Black Girl Sunscreen moisturizing enough to skip lotion?",
    ],
}

# 3) Comparisons — curated pairs (attributed to first-named brand).
COMPARISONS = [
    ("Supergoop", "Supergoop vs EltaMD for everyday face sunscreen — which is better?"),
    ("Supergoop", "Supergoop Unseen vs La Roche-Posay Anthelios — which feels better under makeup?"),
    ("Supergoop", "Is Supergoop better than Sun Bum or just more expensive?"),
    ("Supergoop", "Supergoop Glowscreen vs a drugstore SPF — is the difference real?"),
    ("Supergoop", "Supergoop vs Black Girl Sunscreen for no white cast?"),
    ("EltaMD", "EltaMD UV Clear vs La Roche-Posay Anthelios for acne-prone skin?"),
    ("EltaMD", "EltaMD vs CeraVe sunscreen — is EltaMD worth 3x the price?"),
    ("Neutrogena", "Neutrogena vs Coppertone for a family beach trip?"),
    ("Neutrogena", "Neutrogena Ultra Sheer vs Sun Bum Original — which for sports?"),
    ("La Roche-Posay", "La Roche-Posay vs EltaMD — which do dermatologists prefer?"),
    ("La Roche-Posay", "Anthelios vs Supergoop Unseen for combination skin?"),
    ("Sun Bum", "Sun Bum vs Coppertone Sport for surfing?"),
    ("Sun Bum", "Sun Bum Mineral vs Blue Lizard for reef-safe surfing?"),
    ("CeraVe", "CeraVe sunscreen vs Neutrogena — best drugstore option?"),
    ("CeraVe", "CeraVe AM SPF 30 vs EltaMD UV Daily as a daily moisturizer with SPF?"),
    ("Coppertone", "Coppertone vs Banana Boat — which actually protects better?"),
    ("Black Girl Sunscreen", "Black Girl Sunscreen vs Supergoop Unseen for deep skin tones?"),
    ("Black Girl Sunscreen", "Black Girl Sunscreen vs Fenty Skin Hydra Vizor?"),
]

# 4) Misc branded — purchase-intent and situational, curated
MISC_BRANDED = [
    ("Supergoop", "My dermatologist said wear SPF daily — is Supergoop Unseen a good pick to start with?"),
    ("Supergoop", "Going to Hawaii next month, is Supergoop legal there under the reef law?"),
    ("Supergoop", "Is there a Supergoop set that's good as a gift?"),
    ("Supergoop", "Does Sephora or Amazon have better prices on Supergoop?"),
    ("EltaMD", "My esthetician recommended EltaMD — where do I even buy it?"),
    ("EltaMD", "Is EltaMD on Amazon legit or should I buy from a derm's office?"),
    ("La Roche-Posay", "Is the French version of Anthelios better than the US one?"),
    ("Neutrogena", "Is Neutrogena's spray sunscreen safe to breathe around kids?"),
    ("Sun Bum", "Is Sun Bum's lip balm SPF worth adding to a beach order?"),
    ("Coppertone", "My kid hates sunscreen — is Coppertone Water Babies easy to rub in fast?"),
    ("CeraVe", "Can I just use CeraVe AM lotion and skip a separate sunscreen for the office?"),
    ("Black Girl Sunscreen", "Which Black Girl Sunscreen should I get for oily acne-prone skin?"),
]

# --------------------------------------------------------------- category ---
CATEGORY_QUERIES = [
    # best-of, direct
    "What's the best face sunscreen?",
    "Best sunscreen for everyday use?",
    "Best sunscreen for oily skin?",
    "Best sunscreen for dry skin?",
    "Best sunscreen for sensitive skin?",
    "Best sunscreen for acne-prone skin that won't clog pores?",
    "Best sunscreen with no white cast for dark skin?",
    "Best mineral sunscreen for the face?",
    "Best chemical sunscreen that doesn't sting eyes?",
    "Best reef-safe sunscreen?",
    "Best sunscreen to wear under makeup?",
    "Best drugstore sunscreen under $15?",
    "Best high-end sunscreen that's actually worth it?",
    "Best sunscreen for kids?",
    "Best baby-safe sunscreen?",
    "Best sunscreen for swimming and water sports?",
    "Best sweat-proof sunscreen for running?",
    "Best spray sunscreen that actually works?",
    "Best SPF 50 face sunscreen?",
    "Best tinted sunscreen?",
    "Best sunscreen for rosacea?",
    "Best sunscreen for mature skin?",
    "Best sunscreen for men who hate the greasy feeling?",
    "Best sunscreen stick for reapplying over makeup?",
    "Best Korean or Japanese sunscreen I can buy in the US?",
    "Best pregnancy-safe sunscreen?",
    "Best fragrance-free sunscreen?",
    "Best sunscreen for a beach vacation?",
    "Best facial moisturizer with SPF built in?",
    "Best matte-finish sunscreen for oily skin?",
    # recommend-me phrasing
    "Recommend a sunscreen for combination skin that works as a primer.",
    "Recommend a sunscreen for a toddler with eczema.",
    "Recommend a lightweight daily SPF I'll actually wear.",
    "Recommend a sunscreen for hiking at altitude.",
    "Recommend a sunscreen for tattooed skin.",
    "Recommend a face sunscreen that plays well with retinol.",
    "Recommend a sunscreen for someone who breaks out from everything.",
    "Recommend a reef-safe sunscreen for a Hawaii trip.",
    "Recommend a sunscreen that won't flash back in photos.",
    "Recommend a sunscreen for a bald head.",
    # question phrasing
    "What sunscreen do dermatologists actually use themselves?",
    "What sunscreen should I buy if I've never worn it daily before?",
    "What's the best sunscreen at Target right now?",
    "What sunscreen won't pill under foundation?",
    "What's a good sunscreen that doesn't feel like sunscreen?",
    "What sunscreen is best for melasma?",
    "What SPF should I use daily, and which product?",
    "What's the best sunscreen at Ulta?",
    "What's the best sunscreen on Amazon that's not counterfeit?",
    "What sunscreen do makeup artists use under foundation?",
    # casual phrasing
    "I'm oily and acne-prone, sunscreen recs?",
    "Cheap sunscreen that doesn't suck?",
    "Sunscreen that won't make me look ghostly, go.",
    "Going to Cabo Friday, what sunscreen do I throw in my bag?",
    "My face burns through SPF 30 — what should I switch to?",
    "Sunscreen for my teenage son who plays soccer outside all day?",
    "I hate reapplying — is there a sunscreen that lasts longest?",
    "Every sunscreen stings my eyes at the gym, help?",
    "What sunscreen for a golfer out 5 hours at a time?",
    "New to skincare, what SPF do I start with?",
    # constraint / attribute driven
    "Is mineral or chemical sunscreen better, and which product should I get?",
    "Which sunscreens are actually reef safe, not just labeled that way?",
    "Which sunscreen has the best ingredients according to EWG?",
    "Which sunscreens are non-comedogenic and fragrance free?",
    "Which sunscreen is safest for pregnancy according to OBs?",
    "Which sunscreens don't have oxybenzone or octinoxate?",
    "Which SPF moisturizer is enough for an office job with no sun?",
    "Which sunscreen works best over a vitamin C serum?",
    "Which sunscreen is best for eczema-prone skin?",
    "Which sunscreen brand is most trusted by dermatologists?",
    # shopping / venue driven
    "What's the best sunscreen I can grab at CVS tonight?",
    "Best sunscreen deals right now — what's worth stocking up on?",
    "Building a Sephora order — which SPF should I add?",
    "One sunscreen for face and body for a minimalist — what do I buy?",
    "What sunscreen should I put in my kid's summer camp bag?",
    "Best sunscreen multipack for a family of five?",
    "What travel-size sunscreen is TSA friendly and good?",
    "I only buy clean beauty — which sunscreen qualifies?",
    "What's the best subscription-worthy sunscreen I'll rebuy monthly?",
    "Best sunscreen under $10 that dermatologists still approve of?",
]

# ------------------------------------------------------------------- build --
def build():
    queries = []
    def add(qtype, brand, text):
        queries.append({"id": f"{'b' if qtype=='branded' else 'c'}-{len(queries)+1:03d}",
                        "type": qtype, "brand": brand, "text": text})

    for brand in BRANDS:
        for t in BRAND_TEMPLATES:
            add("branded", brand, t.format(b=brand))
    for brand, qs in PRODUCT_QUERIES.items():
        for q in qs:
            add("branded", brand, q)
    for brand, q in COMPARISONS:
        add("branded", brand, q)
    for brand, q in MISC_BRANDED:
        add("branded", brand, q)
    for q in CATEGORY_QUERIES:
        add("category", None, q)

    texts = [q["text"] for q in queries]
    dupes = [t for t, n in Counter(texts).items() if n > 1]
    assert not dupes, f"duplicate queries: {dupes}"

    return queries

if __name__ == "__main__":
    queries = build()
    branded = [q for q in queries if q["type"] == "branded"]
    category = [q for q in queries if q["type"] == "category"]

    with open("queries.json", "w") as f:
        json.dump({
            "target_brand": TARGET_BRAND,
            "counts": {"total": len(queries), "branded": len(branded), "category": len(category)},
            "queries": queries,
        }, f, indent=2)

    with open("brands.json", "w") as f:
        json.dump({
            "target_brand": TARGET_BRAND,
            "brands": [{"name": b, "aliases": v["aliases"], "products": v["products"]}
                       for b, v in BRANDS.items()],
            # extra names the regex scorer should recognize but no customer is tracking;
            # prevents "other brands" from silently inflating nobody's share
            "untracked_mentions": ["Blue Lizard", "Banana Boat", "Fenty Skin", "Hydra Vizor",
                                    "Aveeno", "Cetaphil", "Vanicream", "Australian Gold",
                                    "Hawaiian Tropic", "Beauty of Joseon", "Biore", "ISNTREE",
                                    "Trader Joe's", "Kinfield", "Vacation", "Shiseido", "Colorescience"],
        }, f, indent=2)

    print(f"total={len(queries)}  branded={len(branded)} ({len(branded)/len(queries):.0%})  "
          f"category={len(category)} ({len(category)/len(queries):.0%})")
    per_brand = Counter(q["brand"] for q in branded)
    for b, n in per_brand.most_common():
        print(f"  {b}: {n}")
