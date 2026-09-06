-- Starter template + price book.
-- Deliberately tuned so the seeded demo reproduces the wireframe in
-- docs/auto-quoting/ui-and-ai-spec.md §1.1 exactly: 45m² erect + 5 days hire +
-- dismantle = £1,835 at 32% margin against a 30% target.

INSERT INTO price_book (code, description, category, unit, unit_cost, unit_price) VALUES
  ('scaffold_erect',    'Scaffold erect',              'labour',   'm2',    18.50,  27.00),
  ('scaffold_hire',     'Scaffold hire',               'plant',    'days',  40.00,  68.00),
  ('scaffold_dismantle','Dismantle',                   'labour',   'job',  215.00, 280.00),
  ('gutter_clearance',  'Gutter clearance',            'labour',   'job',  110.00, 180.00),
  ('extra_lift',        'Extra lift',                  'labour',   'job',  140.00, 210.00),
  ('permit_road',       'Road closure / permit',       'other',    'job',  180.00, 240.00),
  ('waste_removal',     'Waste removal',               'other',    'job',   95.00, 150.00),
  ('roof_strip',        'Strip existing roof covering','labour',   'm2',    22.00,  34.00),
  ('roof_tile',         'Re-tile roof',                'material', 'm2',    41.00,  62.00),
  ('labourer_day',      'Labourer day rate',           'labour',   'days', 145.00, 220.00),
  ('site_lead_day',     'Site lead day rate',          'labour',   'days', 210.00, 310.00);

INSERT INTO quote_templates
  (id, job_type, name, default_margin, margin_floor, validity_days, terms, exclusions, line_items, optional_extras)
VALUES (
  'tpl_domestic_scaffold',
  'domestic_scaffold_erect',
  'Domestic Scaffold Erect',
  30.0,
  25.0,
  30,
  'Payment due 14 days from invoice. Scaffold remains our property throughout the hire period.',
  'Excludes road closure permits, ground works, and out-of-hours access unless stated.',
  json('[
    {"line_code":"scaffold_erect","description":"Scaffold erect","unit":"m2","default_quantity":null,"always_include":true,"locked":false},
    {"line_code":"scaffold_hire","description":"Scaffold hire","unit":"days","default_quantity":7,"always_include":true,"locked":false},
    {"line_code":"scaffold_dismantle","description":"Dismantle","unit":"job","default_quantity":1,"always_include":true,"locked":false},
    {"line_code":"permit_road","description":"Road closure / permit","unit":"job","default_quantity":1,"always_include":false,"locked":false},
    {"line_code":"waste_removal","description":"Waste removal","unit":"job","default_quantity":1,"always_include":false,"locked":false}
  ]'),
  json('[
    {"line_code":"gutter_clearance","description":"Gutter clearance","blurb":"Clear & flush all gutters while scaffold is up"},
    {"line_code":"extra_lift","description":"Extra lift","blurb":"Access to chimney level"}
  ]')
);

INSERT INTO quote_templates
  (id, job_type, name, default_margin, margin_floor, validity_days, terms, exclusions, line_items, optional_extras)
VALUES (
  'tpl_reroof',
  'domestic_reroof',
  'Domestic Re-roof',
  35.0,
  28.0,
  30,
  'Payment due 14 days from invoice. 50% materials deposit on booking.',
  'Excludes structural timber replacement, discovered on strip-back and quoted separately.',
  json('[
    {"line_code":"roof_strip","description":"Strip existing roof covering","unit":"m2","default_quantity":null,"always_include":true,"locked":false},
    {"line_code":"roof_tile","description":"Re-tile roof","unit":"m2","default_quantity":null,"always_include":true,"locked":false},
    {"line_code":"waste_removal","description":"Waste removal","unit":"job","default_quantity":1,"always_include":true,"locked":false},
    {"line_code":"scaffold_erect","description":"Scaffold erect","unit":"m2","default_quantity":null,"always_include":false,"locked":false}
  ]'),
  json('[
    {"line_code":"gutter_clearance","description":"Gutter clearance","blurb":"New gutters cleared and flushed on completion"}
  ]')
);

-- Completed jobs, used only as a scale sanity-check for the AI (§2.2 "last 5 similar jobs")
-- and later as the seed of the quoted-vs-actual learning loop.
INSERT INTO quotes (id, public_token, template_id, job_type, client_name, site_address,
                    description, status, subtotal_cost, subtotal_price, margin_pct,
                    margin_floor, target_margin, valid_until, created_at, sent_at, accepted_at)
VALUES
  ('q_seed_vine','tok_seed_vine','tpl_domestic_scaffold','domestic_scaffold_erect',
   'M. Okafor','22 Vine Rd','Scaffold erect to rear, 2 lifts','accepted',
   1330.0,1780.0,25.3,25.0,30.0,'2026-06-01','2026-05-02','2026-05-02','2026-05-04'),
  ('q_seed_ash','tok_seed_ash','tpl_domestic_scaffold','domestic_scaffold_erect',
   'D. Whitfield','8 Ashfield Cl','Side elevation scaffold, single lift','accepted',
   1010.0,1420.0,28.9,25.0,30.0,'2026-06-14','2026-05-15','2026-05-15','2026-05-18');

-- The quoted lines behind those two jobs. Rates are held on the line rather than
-- read from today's price book, because a historical quote is a snapshot — rates
-- move, and a past job must not silently reprice itself.
INSERT INTO quote_line_items
  (id, quote_id, position, line_code, description, quantity, unit, unit_cost, unit_price, category, kind, source, confidence, confirmed)
VALUES
  ('li_seed_v1','q_seed_vine',0,'scaffold_erect',    'Scaffold erect',45,'m2',  19.50, 26.00,'labour','base','owner_entered','high',1),
  ('li_seed_v2','q_seed_vine',1,'scaffold_hire',     'Scaffold hire',  5,'days',45.00, 68.00,'plant', 'base','owner_entered','high',1),
  ('li_seed_v3','q_seed_vine',2,'scaffold_dismantle','Dismantle',      1,'job',227.50,270.00,'labour','base','owner_entered','high',1),
  ('li_seed_a1','q_seed_ash', 0,'scaffold_erect',    'Scaffold erect',32,'m2',  19.50, 26.00,'labour','base','owner_entered','high',1),
  ('li_seed_a2','q_seed_ash', 1,'scaffold_hire',     'Scaffold hire',  4,'days',45.00, 68.00,'plant', 'base','owner_entered','high',1),
  ('li_seed_a3','q_seed_ash', 2,'scaffold_dismantle','Dismantle',      1,'job',206.00,316.00,'labour','base','owner_entered','high',1);

INSERT INTO jobs (id, quote_id, client_name, site_address, job_type, status, budget_baseline, cost_baseline)
VALUES
  ('job_seed_vine','q_seed_vine','M. Okafor','22 Vine Rd','domestic_scaffold_erect','complete',1780.0,1330.0),
  ('job_seed_ash','q_seed_ash','D. Whitfield','8 Ashfield Cl','domestic_scaffold_erect','complete',1420.0,1010.0);
