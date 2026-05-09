const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ────────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ── Helpers ───────────────────────────────────────────────────────────────
const ok   = (res, data, status = 200) => res.status(status).json(data);
const fail = (res, msg, status = 400)  => res.status(status).json({ error: msg });
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (e.code === '23503') return fail(res, 'Cannot delete: still referenced by another record.', 409);
  if (e.code === '23505') return fail(res, 'Already exists.', 409);
  if (e.code === '23514') return fail(res, 'Invalid format (expiry must be MM/YYYY).', 400);
  console.error(e.message);
  fail(res, e.message, 500);
});

// ── Airports ──────────────────────────────────────────────────────────────
app.get('/airports', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT iata_code, name, country, state FROM airport ORDER BY name');
  ok(res, rows);
}));

// ── Customers ─────────────────────────────────────────────────────────────
app.get('/customers/:email', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT email, name, home_airport_code FROM customer WHERE email=$1', [req.params.email]);
  if (!rows.length) return fail(res, 'Customer not found', 404);
  ok(res, rows[0]);
}));

app.post('/customers', wrap(async (req, res) => {
  const { email, name, home_airport_code } = req.body;
  if (!email || !name) return fail(res, 'email and name required');
  const { rows } = await db.query(
    `INSERT INTO customer (email, name, home_airport_code) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO NOTHING RETURNING *`,
    [email, name, home_airport_code || null]
  );
  if (!rows.length) return fail(res, 'Email already registered', 409);
  ok(res, rows[0], 201);
}));

app.put('/customers/:email', wrap(async (req, res) => {
  const { name, home_airport_code } = req.body;
  const { rows } = await db.query(
    'UPDATE customer SET name=$1, home_airport_code=$2 WHERE email=$3 RETURNING *',
    [name, home_airport_code || null, req.params.email]
  );
  if (!rows.length) return fail(res, 'Customer not found', 404);
  ok(res, rows[0]);
}));

// ── Addresses ─────────────────────────────────────────────────────────────
app.get('/addresses', wrap(async (req, res) => {
  const { email } = req.query;
  if (!email) return fail(res, 'email required');
  const { rows } = await db.query(
    `SELECT a.*,
       (SELECT COUNT(*) FROM credit_card cc WHERE cc.billing_address_id = a.address_id) > 0 AS is_billing
     FROM address a WHERE a.customer_email = $1 ORDER BY a.address_id`,
    [email]
  );
  ok(res, rows);
}));

app.post('/addresses', wrap(async (req, res) => {
  const { street, city, state, country, customer_email } = req.body;
  if (!street || !city || !country || !customer_email) return fail(res, 'street, city, country, customer_email required');
  const { rows } = await db.query(
    'INSERT INTO address (street,city,state,country,customer_email) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [street, city, state || null, country, customer_email]
  );
  ok(res, rows[0], 201);
}));

app.delete('/addresses/:id', wrap(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM address WHERE address_id=$1', [req.params.id]);
  if (!rowCount) return fail(res, 'Not found', 404);
  ok(res, { ok: true });
}));

// ── Credit cards ──────────────────────────────────────────────────────────
app.get('/cards', wrap(async (req, res) => {
  const { email } = req.query;
  if (!email) return fail(res, 'email required');
  const { rows } = await db.query(
    `SELECT cc.card_number, cc.card_holder, cc.expiry, cc.billing_address_id,
            a.street, a.city, a.state, a.country
     FROM credit_card cc JOIN address a ON a.address_id = cc.billing_address_id
     WHERE cc.customer_email = $1 ORDER BY cc.card_number`,
    [email]
  );
  ok(res, rows);
}));

app.post('/cards', wrap(async (req, res) => {
  const { card_number, card_holder, expiry, customer_email, billing_address_id } = req.body;
  if (!card_number || !card_holder || !expiry || !customer_email || !billing_address_id)
    return fail(res, 'All fields required');
  const { rows } = await db.query(
    'INSERT INTO credit_card (card_number,card_holder,expiry,customer_email,billing_address_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [card_number, card_holder, expiry, customer_email, billing_address_id]
  );
  ok(res, rows[0], 201);
}));

app.delete('/cards/:num', wrap(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM credit_card WHERE card_number=$1', [req.params.num]);
  if (!rowCount) return fail(res, 'Not found', 404);
  ok(res, { ok: true });
}));

// ── Flights search ────────────────────────────────────────────────────────
app.get('/flights', wrap(async (req, res) => {
  const { dep, arr, date, class: cls, maxPrice, sort } = req.query;
  if (!dep || !arr || !date) return fail(res, 'dep, arr, date required');

  const { rows } = await db.query(
    `SELECT
       f.airline_code, f.flight_number, f.flight_date,
       f.departure_airport, f.arrival_airport,
       f.departure_time, f.arrival_time,
       f.first_class_capacity, f.economy_capacity,
       al.name AS airline_name,
       da.name AS dep_name,
       aa.name AS arr_name,
       COALESCE(SUM(CASE WHEN bf.seat_class = 'First'   THEN 1 ELSE 0 END), 0) AS first_booked,
       COALESCE(SUM(CASE WHEN bf.seat_class = 'Economy' THEN 1 ELSE 0 END), 0) AS eco_booked,
       MAX(CASE WHEN p.seat_class = 'First'   THEN p.amount END) AS first_price,
       MAX(CASE WHEN p.seat_class = 'Economy' THEN p.amount END) AS eco_price
     FROM flight f
     JOIN airline  al ON al.code      = f.airline_code
     JOIN airport  da ON da.iata_code = f.departure_airport
     JOIN airport  aa ON aa.iata_code = f.arrival_airport
     LEFT JOIN price p ON p.airline_code=f.airline_code AND p.flight_number=f.flight_number AND p.flight_date=f.flight_date
     LEFT JOIN booking_flight bf ON bf.airline_code=f.airline_code AND bf.flight_number=f.flight_number AND bf.flight_date=f.flight_date
     WHERE f.departure_airport=$1 AND f.arrival_airport=$2 AND f.flight_date=$3
     GROUP BY f.airline_code,f.flight_number,f.flight_date,f.departure_airport,f.arrival_airport,
              f.departure_time,f.arrival_time,f.first_class_capacity,f.economy_capacity,
              al.name,da.name,aa.name`,
    [dep, arr, date]
  );

  let results = rows.map(r => ({
    ...r,
    first_available: r.first_class_capacity - parseInt(r.first_booked),
    eco_available:   r.economy_capacity     - parseInt(r.eco_booked),
  })).filter(r => {
    if (cls === 'Economy' && r.eco_available   <= 0) return false;
    if (cls === 'First'   && r.first_available <= 0) return false;
    if ((!cls || cls === 'Any') && r.eco_available <= 0 && r.first_available <= 0) return false;
    if (maxPrice) {
      const min = cls === 'Economy' ? r.eco_price : cls === 'First' ? r.first_price
                : Math.min(r.eco_price ?? Infinity, r.first_price ?? Infinity);
      if (parseFloat(min) > parseFloat(maxPrice)) return false;
    }
    return true;
  });

  results.sort((a, b) => {
    if (sort === 'duration') {
      const dur = r => {
        const [dh,dm] = String(r.departure_time).split(':').map(Number);
        const [ah,am] = String(r.arrival_time).split(':').map(Number);
        return (ah*60+am)-(dh*60+dm);
      };
      return dur(a)-dur(b);
    }
    return parseFloat(a.eco_price||a.first_price||9999) - parseFloat(b.eco_price||b.first_price||9999);
  });

  ok(res, results);
}));

// ── Bookings ──────────────────────────────────────────────────────────────
app.get('/bookings', wrap(async (req, res) => {
  const { email } = req.query;
  if (!email) return fail(res, 'email required');
  const { rows } = await db.query(
    `SELECT b.booking_id, b.customer_email,
            bf.airline_code, bf.flight_number, bf.flight_date, bf.seat_class, bf.card_number,
            f.departure_airport, f.arrival_airport, f.departure_time, f.arrival_time,
            da.name AS dep_name, aa.name AS arr_name, al.name AS airline_name,
            p.amount AS price
     FROM booking b
     JOIN booking_flight bf ON bf.booking_id=b.booking_id
     JOIN flight f  ON f.airline_code=bf.airline_code AND f.flight_number=bf.flight_number AND f.flight_date=bf.flight_date
     JOIN airport da ON da.iata_code=f.departure_airport
     JOIN airport aa ON aa.iata_code=f.arrival_airport
     JOIN airline al ON al.code=f.airline_code
     LEFT JOIN price p ON p.airline_code=bf.airline_code AND p.flight_number=bf.flight_number AND p.flight_date=bf.flight_date AND p.seat_class=bf.seat_class
     WHERE b.customer_email=$1 ORDER BY b.booking_id DESC`,
    [email]
  );
  const map = new Map();
  rows.forEach(r => {
    if (!map.has(r.booking_id)) map.set(r.booking_id, { booking_id: r.booking_id, flights: [] });
    map.get(r.booking_id).flights.push(r);
  });
  ok(res, [...map.values()]);
}));

app.post('/bookings', wrap(async (req, res) => {
  const { customer_email, airline_code, flight_number, flight_date, seat_class, card_number } = req.body;
  if (!customer_email || !airline_code || !flight_number || !flight_date || !seat_class || !card_number)
    return fail(res, 'All fields required');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the flight row first (no GROUP BY = valid FOR UPDATE)
    const { rows: flLock } = await client.query(
      `SELECT first_class_capacity, economy_capacity FROM flight
       WHERE airline_code=$1 AND flight_number=$2 AND flight_date=$3 FOR UPDATE`,
      [airline_code, flight_number, flight_date]
    );
    if (!flLock.length) { await client.query('ROLLBACK'); return fail(res, 'Flight not found', 404); }

    // Count booked seats separately
    const { rows: counts } = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN seat_class='First'   THEN 1 ELSE 0 END), 0) AS fb,
         COALESCE(SUM(CASE WHEN seat_class='Economy' THEN 1 ELSE 0 END), 0) AS eb
       FROM booking_flight
       WHERE airline_code=$1 AND flight_number=$2 AND flight_date=$3`,
      [airline_code, flight_number, flight_date]
    );

    const { first_class_capacity, economy_capacity } = flLock[0];
    const fb = parseInt(counts[0].fb), eb = parseInt(counts[0].eb);

    if (seat_class === 'First'   && first_class_capacity - fb <= 0) { await client.query('ROLLBACK'); return fail(res, 'No First class seats available', 409); }
    if (seat_class === 'Economy' && economy_capacity     - eb <= 0) { await client.query('ROLLBACK'); return fail(res, 'No Economy seats available', 409); }

    const { rows: cardChk } = await client.query(
      'SELECT 1 FROM credit_card WHERE card_number=$1 AND customer_email=$2', [card_number, customer_email]
    );
    if (!cardChk.length) { await client.query('ROLLBACK'); return fail(res, 'Card not found for this customer', 403); }

    const { rows: b } = await client.query(
      'INSERT INTO booking (customer_email) VALUES ($1) RETURNING booking_id', [customer_email]
    );
    await client.query(
      `INSERT INTO booking_flight (booking_id,airline_code,flight_number,flight_date,seat_class,card_number)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [b[0].booking_id, airline_code, flight_number, flight_date, seat_class, card_number]
    );
    await client.query('COMMIT');

    const { rows: p } = await db.query(
      'SELECT amount FROM price WHERE airline_code=$1 AND flight_number=$2 AND flight_date=$3 AND seat_class=$4',
      [airline_code, flight_number, flight_date, seat_class]
    );
    ok(res, { booking_id: b[0].booking_id, price: p[0]?.amount }, 201);
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

app.delete('/bookings/:id', wrap(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM booking WHERE booking_id=$1', [req.params.id]);
  if (!rowCount) return fail(res, 'Not found', 404);
  ok(res, { ok: true });
}));

// ── Serve frontend ────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✈  Skyvil → http://localhost:${PORT}\n`));
