#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dbUrl = process.env.DB_URL;
const psql = process.env.PSQL_BIN ?? "psql";
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !dbUrl) {
  throw new Error("Refusing without NAILIQ_DISPOSABLE_DB=1 and DB_URL");
}
const host = new URL(dbUrl).hostname;
if (!["", "localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-local database host: ${host}`);
}

const id = {
  salon: "18003610-0000-4000-8000-000000000001",
  serviceA: "18003610-0000-4000-8000-000000000002",
  serviceB: "18003610-0000-4000-8000-000000000003",
  staffA: "18003610-0000-4000-8000-000000000004",
  staffB: "18003610-0000-4000-8000-000000000005",
  resource: "18003610-0000-4000-8000-000000000006",
  voucher: "18003610-0000-4000-8000-000000000007",
  otpSession: "18003610-0000-4000-8000-000000000008",
};
const phones = [
  "16045551801",
  "16045551802",
  "16045551803",
  "16045551804",
  "16045551805",
  "16045551806",
  "16045551807",
  "16045551808",
  "16045551809",
  "16045551810",
];

async function sql(statement) {
  const { stdout } = await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout.trim();
}
function lastJson(output) {
  const line = output
    .split("\n")
    .filter((value) => value.startsWith("{"))
    .at(-1);
  return line ? JSON.parse(line) : null;
}
const literal = (value) =>
  `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const at = (base, hours, minutes = 0) =>
  new Date(Date.parse(base) + (hours * 60 + minutes) * 60_000).toISOString();
const line = (lineId, position, serviceId, staff, resource = null) => ({
  line_id: lineId,
  position,
  service_id: serviceId,
  staff_preference: staff,
  preferred_resource_id: resource,
  addon_service_ids: [],
});
const request = ({ requestId, start, phone, lines, voucherCode = null, otpSessionId = null }) => ({
  contract_version: 1,
  salon_id: id.salon,
  request_id: requestId,
  requested_start_time_utc: start,
  lines,
  same_staff_for_all: false,
  voucher_code: voucherCode,
  apply_email_discount: false,
  customer: {
    name: `Sequence ${phone}`,
    phone,
    email: `${phone}@example.test`,
  },
  ...(otpSessionId ? { otp_session_id: otpSessionId } : {}),
});
const quoteSql = (payload) => `
  begin;
  select set_config('request.jwt.claim.role','service_role',true);
  select public.quote_public_booking_sequence(${literal(payload)})::text;
  commit;
`;
const createSql = (payload, fingerprint) => `
  begin;
  select set_config('request.jwt.claim.role','service_role',true);
  select public.create_public_booking_sequence(
    ${literal({ ...payload, expected_pricing_fingerprint: fingerprint })}
  )::text;
  commit;
`;
const replaySql = (payload, fingerprint, bookingId, holdSeconds = 0) => `
  begin;
  select set_config('request.jwt.claim.role','service_role',true);
  select id from public.bookings where id='${bookingId}' for share;
  select pg_sleep(${holdSeconds});
  select public.replay_public_booking_sequence(
    ${literal({ ...payload, expected_pricing_fingerprint: fingerprint })}
  )::text;
  commit;
`;
const quote = async (payload) => lastJson(await sql(quoteSql(payload)));
const rescheduleQuoteSql = (tokenId, requestId, start) => `
  begin; select set_config('request.jwt.claim.role','service_role',true);
  select public.quote_booking_sequence_reschedule(
    '${tokenId}','${requestId}','${start}'::timestamptz
  )::text; commit;
`;
const rescheduleApplySql = (tokenId, requestId, start, fingerprint) => `
  begin; select set_config('request.jwt.claim.role','service_role',true);
  select public.reschedule_booking_sequence_with_management_capability(
    '${tokenId}','${requestId}','${start}'::timestamptz,'${fingerprint}'
  )::text; commit;
`;

async function cleanup() {
  await sql(`
    update public.platform_flags set enabled=false
      where key='feature_multi_service_booking';
    update public.platform_settings set multi_service_booking_qa_salon_id=null
      where id='platform' and multi_service_booking_qa_salon_id='${id.salon}';
    delete from public.client_profiles where phone=any(array[
      ${phones.map((phone) => `'${phone}'`).join(",")}
    ]::text[]);
    delete from public.salons where id='${id.salon}';
    delete from public.service_categories where slug='sequence-concurrency-qa';
  `);
}

try {
  await cleanup();
  await sql(`
    select set_config('request.jwt.claim.role','service_role',true);
    insert into public.service_categories(slug,name_en,name_vi)
      values('sequence-concurrency-qa','Sequence concurrency','Sequence concurrency');
    insert into public.salons(
      id,slug,name,phone,timezone,currency_code,opening_hours,tax_lines,
      subscription_plan,subscription_status,is_beta,feature_flags
    ) values(
      '${id.salon}','sequence-concurrency-qa','Sequence concurrency QA',
      '+16045551800','UTC','CAD',
      '{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}'::jsonb,
      '[{"name":"GST","rate":0.05,"enabled":true}]'::jsonb,
      'premium','active',true,'{}'::jsonb
    );
    insert into public.services(
      id,salon_id,name,price_cents,duration_minutes,buffer_minutes,
      prep_minutes,category,is_addon
    ) values
      ('${id.serviceA}','${id.salon}','Concurrency A',1000,30,0,5,
       'sequence-concurrency-qa',false),
      ('${id.serviceB}','${id.salon}','Concurrency B',1200,20,0,5,
       'sequence-concurrency-qa',false);
    insert into public.staff(id,salon_id,name,status) values
      ('${id.staffA}','${id.salon}','Concurrency Staff A','active'),
      ('${id.staffB}','${id.salon}','Concurrency Staff B','active');
    insert into public.salon_resources(id,salon_id,name,kind,status) values
      ('${id.resource}','${id.salon}','Concurrency Room','room','active');
    insert into public.vouchers(
      id,salon_id,code,kind,amount_off_cents,max_uses,valid_from,expires_at
    ) values(
      '${id.voucher}','${id.salon}','SEQUENCE-LAST-ONE','promo',100,1,
      clock_timestamp()-interval '1 day',clock_timestamp()+interval '30 days'
    );
    insert into public.platform_flags(key,enabled,description)
      values('feature_multi_service_booking',true,'sequence concurrency')
      on conflict(key) do update set enabled=excluded.enabled;
    select public.configure_multi_service_booking_qa_salon(
      '${id.salon}',true,'ENABLE_MULTI_SERVICE_QA'
    )::text;
  `);

  const base = await sql(
    `select (date_trunc('day',clock_timestamp())+interval '12 days 9 hours')::text`,
  );

  // Same request: one first create, one exact replay, identical persisted IDs.
  const replay = request({
    requestId: "18003610-0000-4000-8000-000000000010",
    start: at(base, 0),
    phone: phones[0],
    lines: [
      line("18003610-0000-4000-8000-000000000011", 0, id.serviceA, id.staffA),
    ],
  });
  const replayQuote = await quote(replay);
  assert.equal(replayQuote.success, true, JSON.stringify(replayQuote));
  const replayResults = (
    await Promise.all([
      sql(createSql(replay, replayQuote.pricing_fingerprint)),
      sql(createSql(replay, replayQuote.pricing_fingerprint)),
    ])
  ).map(lastJson);
  assert.deepEqual(replayResults.map((x) => x.idempotent).sort(), [
    false,
    true,
  ]);
  assert.equal(new Set(replayResults.map((x) => x.booking_id)).size, 1);
  assert.deepEqual(replayResults[0].segment_ids, replayResults[1].segment_ids);

  // Replay locks the committed parent while validating parent/segments and
  // receipt. A concurrent lifecycle mutation may run before or after replay,
  // but cannot produce a torn snapshot between those reads.
  const replayBookingId = replayResults[0].booking_id;
  const [lockedReplayOutput] = await Promise.all([
    sql(replaySql(replay, replayQuote.pricing_fingerprint, replayBookingId, 0.4)),
    sql(`select pg_sleep(0.1); begin;
      update public.bookings set status='cancelled' where id='${replayBookingId}';
      commit;`),
  ]);
  const lockedReplay = lastJson(lockedReplayOutput);
  assert.equal(lockedReplay.code, "booked", JSON.stringify(lockedReplay));
  const afterCancelReplay = lastJson(
    await sql(`begin; select set_config('request.jwt.claim.role','service_role',true);
      select public.replay_public_booking_sequence(
        ${literal({ ...replay, expected_pricing_fingerprint: replayQuote.pricing_fingerprint })}
      )::text; commit;`),
  );
  assert.equal(
    afterCancelReplay.code,
    "booking_state_changed",
    JSON.stringify(afterCancelReplay),
  );

  // Two quotes race for the last voucher claim. Loser writes no booking/profile.
  const voucherA = request({
    requestId: "18003610-0000-4000-8000-000000000020",
    start: at(base, 2),
    phone: phones[1],
    voucherCode: "SEQUENCE-LAST-ONE",
    lines: [
      line("18003610-0000-4000-8000-000000000021", 0, id.serviceA, id.staffA),
    ],
  });
  const voucherB = request({
    requestId: "18003610-0000-4000-8000-000000000022",
    start: at(base, 3),
    phone: phones[2],
    voucherCode: "SEQUENCE-LAST-ONE",
    lines: [
      line("18003610-0000-4000-8000-000000000023", 0, id.serviceB, id.staffB),
    ],
  });
  const [voucherQuoteA, voucherQuoteB] = await Promise.all([
    quote(voucherA),
    quote(voucherB),
  ]);
  const voucherResults = (
    await Promise.all([
      sql(createSql(voucherA, voucherQuoteA.pricing_fingerprint)),
      sql(createSql(voucherB, voucherQuoteB.pricing_fingerprint)),
    ])
  ).map(lastJson);
  assert.deepEqual(voucherResults.map((x) => x.code).sort(), [
    "booked",
    "voucher_invalid",
  ]);
  assert.equal(
    await sql(
      `select used_count from public.vouchers where id='${id.voucher}'`,
    ),
    "1",
  );
  assert.equal(
    await sql(
      `select count(*) from public.voucher_redemptions where voucher_id='${id.voucher}'`,
    ),
    "1",
  );
  const voucherLoserPhone =
    voucherResults[0].code === "voucher_invalid" ? phones[1] : phones[2];
  assert.equal(
    await sql(
      `select count(*) from public.client_profiles where phone='${voucherLoserPhone}'`,
    ),
    "0",
  );

  // Cross-model race: the single parent and first sequence segment share the
  // same staff/capacity. Exactly one model may commit.
  const crossRequest = request({
    requestId: "18003610-0000-4000-8000-000000000030",
    start: at(base, 5),
    phone: phones[3],
    lines: [
      line("18003610-0000-4000-8000-000000000031", 0, id.serviceA, id.staffA),
    ],
  });
  const crossQuote = await quote(crossRequest);
  const singleId = "18003610-0000-4000-8000-000000000032";
  const crossSettled = await Promise.allSettled([
    sql(createSql(crossRequest, crossQuote.pricing_fingerprint)),
    sql(`begin; insert into public.bookings(
      id,salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,source,schedule_model
    ) values(
      '${singleId}','${id.salon}','${id.serviceA}','${id.staffA}',
      'Cross single','${phones[4]}','${at(base, 5)}','${at(base, 5, 30)}',
      'confirmed','appointment','single'
    ); commit;`),
  ]);
  const crossSequence =
    crossSettled[0].status === "fulfilled"
      ? lastJson(crossSettled[0].value)
      : null;
  const sequenceCommitted = crossSequence?.code === "booked";
  const singleCommitted =
    (await sql(
      `select count(*) from public.bookings where id='${singleId}'`,
    )) === "1";
  assert.equal(
    Number(sequenceCommitted) + Number(singleCommitted),
    1,
    JSON.stringify({ crossSettled, crossSequence }),
  );
  if (!sequenceCommitted) assert.equal(crossSequence?.code, "slot_conflict");

  // Same resource/different staff race is closed by the resource exclusion.
  await sql(
    `update public.salons set resources_enabled=true where id='${id.salon}'`,
  );
  const resourceA = request({
    requestId: "18003610-0000-4000-8000-000000000040",
    start: at(base, 7),
    phone: phones[5],
    lines: [
      line(
        "18003610-0000-4000-8000-000000000041",
        0,
        id.serviceA,
        id.staffA,
        id.resource,
      ),
    ],
  });
  const resourceB = request({
    requestId: "18003610-0000-4000-8000-000000000042",
    start: at(base, 7),
    phone: phones[6],
    lines: [
      line(
        "18003610-0000-4000-8000-000000000043",
        0,
        id.serviceA,
        id.staffB,
        id.resource,
      ),
    ],
  });
  const [resourceQuoteA, resourceQuoteB] = await Promise.all([
    quote(resourceA),
    quote(resourceB),
  ]);
  const resourceResults = (
    await Promise.all([
      sql(createSql(resourceA, resourceQuoteA.pricing_fingerprint)),
      sql(createSql(resourceB, resourceQuoteB.pricing_fingerprint)),
    ])
  ).map(lastJson);
  assert.deepEqual(resourceResults.map((x) => x.code).sort(), [
    "booked",
    "slot_conflict",
  ]);
  await sql(`update public.salons set resources_enabled=false where id='${id.salon}'`);

  // Two independent sequence bookings quote the same future staff capacity.
  // Exclusion constraints + canonical advisory locks permit exactly one whole-
  // sequence move; the loser retains every old segment and an unconsumed cap.
  const moveA = request({
    requestId: "18003610-0000-4000-8000-000000000070",
    start: at(base, 12), phone: phones[8],
    lines: [line("18003610-0000-4000-8000-000000000071", 0, id.serviceA, id.staffA)],
  });
  const moveB = request({
    requestId: "18003610-0000-4000-8000-000000000072",
    start: at(base, 13), phone: phones[9],
    lines: [line("18003610-0000-4000-8000-000000000073", 0, id.serviceA, id.staffA)],
  });
  const moveQuoteA = await quote(moveA);
  const moveQuoteB = await quote(moveB);
  const moveCreatedA = lastJson(await sql(createSql(moveA, moveQuoteA.pricing_fingerprint)));
  const moveCreatedB = lastJson(await sql(createSql(moveB, moveQuoteB.pricing_fingerprint)));
  const capA = lastJson(await sql(`begin; select set_config('request.jwt.claim.role','service_role',true);
    select public.mint_booking_management_capability(
      '${id.salon}','${moveCreatedA.booking_id}','reschedule','${at(base, 1)}'::timestamptz
    )::text; commit;`));
  const capB = lastJson(await sql(`begin; select set_config('request.jwt.claim.role','service_role',true);
    select public.mint_booking_management_capability(
      '${id.salon}','${moveCreatedB.booking_id}','reschedule','${at(base, 1)}'::timestamptz
    )::text; commit;`));
  const moveTarget = at(base, 16);
  const moveRequestA = "18003610-0000-4000-8000-000000000074";
  const moveRequestB = "18003610-0000-4000-8000-000000000075";
  const scheduleA = lastJson(await sql(rescheduleQuoteSql(capA.token_id, moveRequestA, moveTarget)));
  const scheduleB = lastJson(await sql(rescheduleQuoteSql(capB.token_id, moveRequestB, moveTarget)));
  const moveResults = (
    await Promise.all([
      sql(rescheduleApplySql(capA.token_id, moveRequestA, moveTarget, scheduleA.sequence_fingerprint)),
      sql(rescheduleApplySql(capB.token_id, moveRequestB, moveTarget, scheduleB.sequence_fingerprint)),
    ])
  ).map(lastJson);
  assert.deepEqual(moveResults.map((x) => x.code).sort(), ["rescheduled", "slot_conflict"]);
  const moveLoserBooking = moveResults[0].code === "slot_conflict"
    ? moveCreatedA.booking_id : moveCreatedB.booking_id;
  const moveLoserCap = moveResults[0].code === "slot_conflict" ? capA.token_id : capB.token_id;
  assert.equal(
    await sql(`select count(*) from public.booking_service_segments
      where booking_id='${moveLoserBooking}' and customer_start_utc='${moveTarget}'::timestamptz`),
    "0",
  );
  assert.equal(
    await sql(`select consumed_at is null from public.booking_management_capabilities where id='${moveLoserCap}'`),
    "t",
  );

  // One verified OTP capability cannot authorize two distinct requests. The
  // session row lock serializes both transactions; exactly one booking/profile
  // commits and the loser observes the durable consumed booking binding.
  await sql(`
    insert into public.phone_otp_sessions(id,salon_id,phone,verified_at,expires_at)
    values('${id.otpSession}','${id.salon}','${phones[7]}',clock_timestamp(),
      clock_timestamp()+interval '15 minutes');
    update public.salons set phone_otp_enabled=true where id='${id.salon}';
  `);
  const otpA = request({
    requestId: "18003610-0000-4000-8000-000000000060",
    start: at(base, 10),
    phone: phones[7],
    otpSessionId: id.otpSession,
    lines: [line("18003610-0000-4000-8000-000000000061", 0, id.serviceA, id.staffA)],
  });
  const otpB = request({
    requestId: "18003610-0000-4000-8000-000000000062",
    start: at(base, 11),
    phone: phones[7],
    otpSessionId: id.otpSession,
    lines: [line("18003610-0000-4000-8000-000000000063", 0, id.serviceB, id.staffB)],
  });
  const [otpQuoteA, otpQuoteB] = await Promise.all([quote(otpA), quote(otpB)]);
  const otpResults = (
    await Promise.all([
      sql(createSql(otpA, otpQuoteA.pricing_fingerprint)),
      sql(createSql(otpB, otpQuoteB.pricing_fingerprint)),
    ])
  ).map(lastJson);
  assert.deepEqual(otpResults.map((x) => x.code).sort(), ["booked", "otp_session_used"]);
  const otpWinner = otpResults.find((x) => x.code === "booked");
  assert.equal(
    await sql(`select consumed_by_booking_id::text from public.phone_otp_sessions where id='${id.otpSession}'`),
    otpWinner.booking_id,
  );
  assert.equal(
    await sql(`select count(*) from public.bookings where salon_id='${id.salon}' and idempotency_key in ('${otpA.request_id}','${otpB.request_id}')`),
    "1",
  );
  await sql(`update public.salons set phone_otp_enabled=false where id='${id.salon}'`);

  // Kill-switch and create share a canonical lock order. Either the accepted
  // create commits before disable, or disable wins and create writes nothing.
  const gateRequest = request({
    requestId: "18003610-0000-4000-8000-000000000050",
    start: at(base, 9),
    phone: phones[7],
    lines: [
      line(
        "18003610-0000-4000-8000-000000000051",
        0,
        id.serviceB,
        id.staffB,
        id.resource,
      ),
    ],
  });
  const gateQuote = await quote(gateRequest);
  const [gateCreateOutput, gateDisableOutput] = await Promise.all([
    sql(createSql(gateRequest, gateQuote.pricing_fingerprint)),
    sql(`begin; select set_config('request.jwt.claim.role','service_role',true);
      select public.configure_multi_service_booking_qa_salon(
        '${id.salon}',false,'DISABLE_MULTI_SERVICE_QA'
      )::text; commit;`),
  ]);
  const gateCreate = lastJson(gateCreateOutput);
  const gateDisable = lastJson(gateDisableOutput);
  assert.equal(gateDisable.code, "disabled", JSON.stringify(gateDisable));
  assert.ok(
    ["booked", "feature_disabled"].includes(gateCreate.code),
    JSON.stringify(gateCreate),
  );
  assert.equal(
    await sql(
      `select count(*) from public.bookings where salon_id='${id.salon}' and idempotency_key='${gateRequest.request_id}'`,
    ),
    gateCreate.code === "booked" ? "1" : "0",
  );

  process.stdout.write("PASS booking service sequence concurrency\n");
} finally {
  await cleanup();
}
