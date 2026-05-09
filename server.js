const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ────────────────────────────────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'skyvil',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// ── Helpers ───────────────────────────────────────────────────────────────
const ok  = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (e.code === '23503') return err(res, 'Cannot delete: still referenced by another record.', 409);
  if (e.code === '23505') return err(res, 'Already exists.', 409);
  if (e.code === '23514') return err(res, 'Invalid format (expiry must be MM/YYYY).', 400);
  console.error(e.message);
  err(res, e.message, 500);
});

// ── Airports ──────────────────────────────────────────────────────────────
app.get('/airports', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT iata_code, name, country, state FROM AIRPORT ORDER BY name');
  ok(res, rows);
}));

// ── Customers ─────────────────────────────────────────────────────────────
app.get('/customers/:email', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT email, name, home_airport_code FROM CUSTOMER WHERE email=$1', [req.params.email]);
  if (!rows.length) return err(res, 'Customer not found', 404);
  ok(res, rows[0]);
}));

app.post('/customers', wrap(async (req, res) => {
  const { email, name, home_airport_code } = req.body;
  if (!email || !name) return err(res, 'email and name required');
  const { rows } = await db.query(
    `INSERT INTO CUSTOMER (email, name, home_airport_code) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO NOTHING RETURNING *`,
    [email, name, home_airport_code || null]
  );
  if (!rows.length) return err(res, 'Email already registered', 409);
  ok(res, rows[0], 201);
}));

app.put('/customers/:email', wrap(async (req, res) => {
  const { name, home_airport_code } = req.body;
  const { rows } = await db.query(
    'UPDATE CUSTOMER SET name=$1, home_airport_code=$2 WHERE email=$3 RETURNING *',
    [name, home_airport_code || null, req.params.email]
  );
  if (!rows.length) return err(res, 'Customer not found', 404);
  ok(res, rows[0]);
}));

// ── Addresses ─────────────────────────────────────────────────────────────
app.get('/addresses', wrap(async (req, res) => {
  const { email } = req.query;
  if (!email) return err(res, 'email required');
  const { rows } = await db.query(
    `SELECT a.*,
       (SELECT COUNT(*) FROM CREDIT_CARD cc WHERE cc.billing_address_id=a.address_id)>0 AS is_billing
     FROM ADDRESS a WHERE a.customer_email=$1 ORDER BY a.address_id`,
    [email]
  );
  ok(res, rows);
}));

app.post('/addresses', wrap(async (req, res) => {
  const { street, city, state, country, customer_email } = req.body;
  if (!street || !city || !country || !customer_email) return err(res, 'street, city, country, customer_email required');
  const { rows } = await db.query(
    'INSERT INTO ADDRESS (street,city,state,country,customer_email) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [street, city, state || null, country, customer_email]
  );
  ok(res, rows[0], 201);
}));

app.delete('/addresses/:id', wrap(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM ADDRESS WHERE address_id=$1', [req.params.id]);
  if (!rowCount) return err(res, 'Not found', 404);
  ok(res, { ok: true });
}));

// ── Credit cards ──────────────────────────────────────────────────────────
app.get('/cards', wrap(async (req, res) => {
  const { email } = req.query;
  if (!email) return err(res, 'email required');
  const { rows } = await db.query(
    `SELECT cc.card_number, cc.card_holder, cc.expiry, cc.billing_address_id,
            a.street, a.city, a.state, a.country
     FROM CREDIT_CARD cc JOIN ADDRESS a ON a.address_id=cc.billing_address_id
     WHERE cc.customer_email=$1 ORDER BY cc.card_number`,
    [email]
  );
  ok(res, rows);
}));

app.post('/cards', wrap(async (req, res) => {
  const { card_number, card_holder, expiry, customer_email, billing_address_id } = req.body;
  if (!card_number || !card_holder || !expiry || !customer_email || !billing_address_id)
    return err(res, 'All fields required');
  const { rows } = await db.query(
    'INSERT INTO CREDIT_CARD (card_number,card_holder,expiry,customer_email,billing_address_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [card_number, card_holder, expiry, customer_email, billing_address_id]
  );
  ok(res, rows[0], 201);
}));

app.delete('/cards/:num', wrap(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM CREDIT_CARD WHERE card_number=$1', [req.params.num]);
  if (!rowCount) return err(res, 'Not found', 404);
  ok(res, { ok: true });
}));

// ── Flights search ────────────────────────────────────────────────────────
app.get('/flights', wrap(async (req, res) => {
  const { dep, arr, date, class: cls, maxPrice, sort } = req.query;
  if (!dep || !arr || !date) return err(res, 'dep, arr, date required');

  const { rows } = await db.query(
    `SELECT f.airline_code, f.flight_number, f.flight_date,
            f.departure_airport, f.arrival_airport,
            f.departure_time, f.arrival_time,
            f.first_class_capacity, f.economy_capacity,
            al.name AS airline_name,
            da.name AS dep_name, aa.name AS arr_name,
            COALESCE(SUM(CASE WHEN bf.seat_class='First'   THEN 1 ELSE 0 END),0) AS first_booked,
            COALESCE(SUM(CASE WHEN bf.seat_class='Economy' THEN 1 ELSE 0 END),0) AS eco_booked,
            MAX(CASE WHEN p.seat_class='First'   THEN p.amount END) AS first_price,
            MAX(CASE WHEN p.seat_class='Economy' THEN p.amount END) AS eco_price
     FROM FLIGHT f
     JOIN AIRLINE  al ON al.code=f.airline_code
     JOIN AIRPORT  da ON da.iata_code=f.departure_airport
     JOIN AIRPORT  aa ON aa.iata_code=f.arrival_airport
     LEFT JOIN PRICE p ON p.airline_code=f.airline_code AND p.flight_number=f.flight_number AND p.flight_date=f.flight_date
     LEFT JOIN BOOKING_FLIGHT bf ON bf.airline_code=f.airline_code AND bf.flight_number=f.flight_number AND bf.flight_date=f.flight_date
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
      if (min > parseFloat(maxPrice)) return false;
    }
    return true;
  });

  const mins = r => {
    const [dh,dm] = r.departure_time.split(':').map(Number);
    const [ah,am] = r.arrival_time.split(':').map(Number);
    return (ah*60+am)-(dh*60+dm);
  };
  results.sort((a,b) => sort === 'duration' ? mins(a)-mins(b)
    : (parseFloat(a.eco_price||a.first_price||9999) - parseFloat(b.eco_price||b.first_price||9999)));

  ok(res, results);
}));

// ── Bookings ──────────────────────────────────────────────────────────────
app.get('/bookings', wrap(async (req, res) => {
  const { email } = req.query;
  if (!email) return err(res, 'email required');
  const { rows } = await db.query(
    `SELECT b.booking_id, b.customer_email,
            bf.airline_code, bf.flight_number, bf.flight_date, bf.seat_class, bf.card_number,
            f.departure_airport, f.arrival_airport, f.departure_time, f.arrival_time,
            da.name AS dep_name, aa.name AS arr_name, al.name AS airline_name,
            p.amount AS price
     FROM BOOKING b
     JOIN BOOKING_FLIGHT bf ON bf.booking_id=b.booking_id
     JOIN FLIGHT f  ON f.airline_code=bf.airline_code AND f.flight_number=bf.flight_number AND f.flight_date=bf.flight_date
     JOIN AIRPORT da ON da.iata_code=f.departure_airport
     JOIN AIRPORT aa ON aa.iata_code=f.arrival_airport
     JOIN AIRLINE al ON al.code=f.airline_code
     LEFT JOIN PRICE p ON p.airline_code=bf.airline_code AND p.flight_number=bf.flight_number AND p.flight_date=bf.flight_date AND p.seat_class=bf.seat_class
     WHERE b.customer_email=$1
     ORDER BY b.booking_id DESC`,
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
    return err(res, 'All fields required');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: fl } = await client.query(
      `SELECT f.first_class_capacity, f.economy_capacity,
              COALESCE(SUM(CASE WHEN bf.seat_class='First'   THEN 1 ELSE 0 END),0) AS fb,
              COALESCE(SUM(CASE WHEN bf.seat_class='Economy' THEN 1 ELSE 0 END),0) AS eb
       FROM FLIGHT f
       LEFT JOIN BOOKING_FLIGHT bf ON bf.airline_code=f.airline_code AND bf.flight_number=f.flight_number AND bf.flight_date=f.flight_date
       WHERE f.airline_code=$1 AND f.flight_number=$2 AND f.flight_date=$3
       GROUP BY f.first_class_capacity, f.economy_capacity FOR UPDATE OF f`,
      [airline_code, flight_number, flight_date]
    );
    if (!fl.length) { await client.query('ROLLBACK'); return err(res, 'Flight not found', 404); }
    if (seat_class === 'First'   && fl[0].first_class_capacity - fl[0].fb <= 0) { await client.query('ROLLBACK'); return err(res, 'No First class seats available', 409); }
    if (seat_class === 'Economy' && fl[0].economy_capacity     - fl[0].eb <= 0) { await client.query('ROLLBACK'); return err(res, 'No Economy seats available', 409); }

    const { rows: cardChk } = await client.query(
      'SELECT 1 FROM CREDIT_CARD WHERE card_number=$1 AND customer_email=$2', [card_number, customer_email]
    );
    if (!cardChk.length) { await client.query('ROLLBACK'); return err(res, 'Card not found for this customer', 403); }

    const { rows: b } = await client.query(
      'INSERT INTO BOOKING (customer_email) VALUES ($1) RETURNING booking_id', [customer_email]
    );
    await client.query(
      'INSERT INTO BOOKING_FLIGHT (booking_id,airline_code,flight_number,flight_date,seat_class,card_number) VALUES ($1,$2,$3,$4,$5,$6)',
      [b[0].booking_id, airline_code, flight_number, flight_date, seat_class, card_number]
    );
    await client.query('COMMIT');

    const { rows: p } = await db.query(
      'SELECT amount FROM PRICE WHERE airline_code=$1 AND flight_number=$2 AND flight_date=$3 AND seat_class=$4',
      [airline_code, flight_number, flight_date, seat_class]
    );
    ok(res, { booking_id: b[0].booking_id, price: p[0]?.amount }, 201);
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

app.delete('/bookings/:id', wrap(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM BOOKING WHERE booking_id=$1', [req.params.id]);
  if (!rowCount) return err(res, 'Not found', 404);
  ok(res, { ok: true });
}));

// ── Serve frontend ────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✈  Skyvil → http://localhost:${PORT}\n`));
