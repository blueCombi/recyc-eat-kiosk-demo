/*
  econova_bin.ino — EcoNova reverse vending bin (ESP32 #1)

  Weighs, identifies and sorts the inserted item, then tells the kiosk PC what
  happened over USB serial. The kiosk decides how many points an item is worth
  (staff edit those values in Kiosk Settings), so this sketch only reports the
  material and the size it measured.

  Board: ESP32 dev module. Serial: 115200 baud, newline terminated.

  Host -> bin
    WHO                 identify yourself
    PING                keep-alive
    TARE                re-zero the scale with the platform empty

  Bin -> host
    HELLO|BIN|1
    PONG
    OK|TARE
    EVT|READY                                       idle, waiting for an item
    EVT|DETECT|weight=12.40                         something landed, settling
    EVT|ACCEPT|material=PLASTIC|size=MEDIUM|weight=24.50
    EVT|REJECT|reason=TOO_LIGHT|weight=2.10         also OVERWEIGHT, INVALID_SIZE
    EVT|BUSY                                        compressing and sorting
    EVT|SORTED|material=PLASTIC                     cycle finished
    LOG|<free text>                                 human-readable only
*/
#include "HX711.h"
#include <ESP32Servo.h>

#define CAN_SENSOR 18

#define IR_SMALL   32
#define IR_MEDIUM  33
#define IR_LARGE   34

#define DOUT 12
#define CLK  13

// ODD RELAYS
#define PLASTIC_ODD 25
#define REJECT_ODD  26
#define CAN_ODD     27

// MOTOR RELAYS
#define CAN_FORWARD      14
#define PLASTIC_FORWARD  15

// SERVOS
#define CAN_SERVO      21
#define PLASTIC_SERVO  22

// Anything under this reads as an empty platform.
const float IDLE_GRAMS = 3.0;
// Caps, straws and scraps weigh less than a real container.
const float MIN_ITEM_GRAMS = 7.0;

const float MAX_GRAMS_SMALL  = 40.0;
const float MAX_GRAMS_MEDIUM = 80.0;
const float MAX_GRAMS_LARGE  = 150.0;

HX711 scale;

Servo canServo;
Servo plasticServo;

String hostLine = "";

// ───────────────────────── host protocol ─────────────────────────
void logLine(const char *text)
{
  Serial.print("LOG|");
  Serial.println(text);
}

void sendEvent(const char *name)
{
  Serial.print("EVT|");
  Serial.println(name);
}

void sendDetect(float weight)
{
  Serial.print("EVT|DETECT|weight=");
  Serial.println(weight, 2);
}

void sendAccept(const char *material, const char *sizeName, float weight)
{
  Serial.print("EVT|ACCEPT|material=");
  Serial.print(material);
  Serial.print("|size=");
  Serial.print(sizeName);
  Serial.print("|weight=");
  Serial.println(weight, 2);
}

void sendReject(const char *reason, float weight)
{
  Serial.print("EVT|REJECT|reason=");
  Serial.print(reason);
  Serial.print("|weight=");
  Serial.println(weight, 2);
}

void sendSorted(const char *material)
{
  Serial.print("EVT|SORTED|material=");
  Serial.println(material);
}

void handleHostLine(String line)
{
  line.trim();
  line.toUpperCase();

  if (line.length() == 0)
    return;

  if (line == "WHO")
  {
    Serial.println("HELLO|BIN|1");
  }
  else if (line == "PING")
  {
    Serial.println("PONG");
  }
  else if (line == "TARE")
  {
    scale.tare();
    Serial.println("OK|TARE");
  }
  else
  {
    Serial.print("ERR|UNKNOWN|");
    Serial.println(line);
  }
}

// The kiosk can ask WHO at any moment, including halfway through a compression
// cycle, so every wait in this sketch goes through pollHost / waitMs.
void pollHost()
{
  while (Serial.available())
  {
    char c = Serial.read();

    if (c == '\n' || c == '\r')
    {
      if (hostLine.length())
      {
        handleHostLine(hostLine);
        hostLine = "";
      }
    }
    else if (hostLine.length() < 40)
    {
      hostLine += c;
    }
  }
}

void waitMs(unsigned long ms)
{
  unsigned long start = millis();

  while (millis() - start < ms)
  {
    pollHost();
    delay(5);
  }
}

// ───────────────────────── mechanics ─────────────────────────────
float readWeight(byte samples)
{
  float weight = scale.get_units(samples);

  if (weight < 0)
    weight = -weight;

  if (weight < IDLE_GRAMS)
    weight = 0;

  return weight;
}

void triggerODD(int pin)
{
  digitalWrite(pin, LOW);
  waitMs(1000);
  digitalWrite(pin, HIGH);
}

void sweepServo(Servo &servo)
{
  // Forward
  servo.write(0);
  waitMs(400);

  // Stop
  servo.write(90);
  waitMs(400);

  // Reverse
  servo.write(180);
  waitMs(400);

  // Stop
  servo.write(90);
}

void runCompressor(int motorPin, Servo &servo, const char *material)
{
  waitMs(5000);

  logLine("compressor on");
  digitalWrite(motorPin, LOW);

  waitMs(4000);

  digitalWrite(motorPin, HIGH);
  logLine("compressor off");

  waitMs(500);

  sweepServo(servo);
  // The kiosk waits on this line before it tells the shopper to drop another item.
  sendSorted(material);
}

void goReady()
{
  waitMs(500);
  scale.tare();
  sendEvent("READY");
}

// After a reject the item is still on the platform. Wait for it to leave,
// then re-zero. Do not wait forever: a stuck scale would lock the kiosk.
void waitForRemovalAndReset()
{
  const unsigned long limit = millis() + 15000;

  while (millis() < limit)
  {
    pollHost();

    if (readWeight(3) < IDLE_GRAMS)
      break;

    delay(50);
  }

  goReady();
}

void rejectItem(const char *reason, float weight)
{
  sendReject(reason, weight);
  sendEvent("BUSY");
  triggerODD(REJECT_ODD);
  waitForRemovalAndReset();
}

// ───────────────────────── setup / loop ──────────────────────────
void setup()
{
  Serial.begin(115200);

  pinMode(CAN_SENSOR, INPUT_PULLUP);

  pinMode(IR_SMALL, INPUT);
  pinMode(IR_MEDIUM, INPUT);
  pinMode(IR_LARGE, INPUT);

  pinMode(PLASTIC_ODD, OUTPUT);
  pinMode(REJECT_ODD, OUTPUT);
  pinMode(CAN_ODD, OUTPUT);

  pinMode(CAN_FORWARD, OUTPUT);
  pinMode(PLASTIC_FORWARD, OUTPUT);

  digitalWrite(PLASTIC_ODD, HIGH);
  digitalWrite(REJECT_ODD, HIGH);
  digitalWrite(CAN_ODD, HIGH);

  digitalWrite(CAN_FORWARD, HIGH);
  digitalWrite(PLASTIC_FORWARD, HIGH);

  canServo.attach(CAN_SERVO, 500, 2400);
  plasticServo.attach(PLASTIC_SERVO, 500, 2400);

  canServo.write(90);
  plasticServo.write(90);

  scale.begin(DOUT, CLK);
  scale.set_scale(-446.0);

  // The load cell needs a moment to settle before the first zero.
  waitMs(5000);

  scale.tare();

  Serial.println("HELLO|BIN|1");
  sendEvent("READY");
}

void loop()
{
  pollHost();

  float weight = readWeight(5);

  // WAIT FOR ITEM
  if (weight < IDLE_GRAMS)
  {
    delay(50);
    return;
  }

  sendDetect(weight);

  // SETTLE WEIGHT
  waitMs(300);

  weight = readWeight(5);

  // REJECT VERY LIGHT ITEMS
  if (weight <= MIN_ITEM_GRAMS)
  {
    rejectItem("TOO_LIGHT", weight);
    return;
  }

  // MATERIAL DETECTION — the inductive sensor pulls low on metal.
  const char *material = digitalRead(CAN_SENSOR) == LOW ? "CAN" : "PLASTIC";

  int small  = digitalRead(IR_SMALL);
  int medium = digitalRead(IR_MEDIUM);
  int large  = digitalRead(IR_LARGE);

  const char *sizeName = NULL;
  float maxWeight = 0;

  // SIZE DETECTION — the beams break from the bottom up, so a taller item
  // breaks every beam below it too.
  if (small == 1 && medium == 0 && large == 0)
  {
    sizeName = "SMALL";
    maxWeight = MAX_GRAMS_SMALL;
  }
  else if (small == 1 && medium == 1 && large == 0)
  {
    sizeName = "MEDIUM";
    maxWeight = MAX_GRAMS_MEDIUM;
  }
  else if (small == 1 && medium == 1 && large == 1)
  {
    sizeName = "LARGE";
    maxWeight = MAX_GRAMS_LARGE;
  }
  else
  {
    rejectItem("INVALID_SIZE", weight);
    return;
  }

  // A container heavier than its size allows still has liquid in it.
  if (weight > maxWeight)
  {
    rejectItem("OVERWEIGHT", weight);
    return;
  }

  // Points are awarded the moment the bin commits to keeping the item, so the
  // shopper is not left watching a blank screen for the whole sort cycle.
  sendAccept(material, sizeName, weight);
  sendEvent("BUSY");

  if (strcmp(material, "CAN") == 0)
  {
    triggerODD(CAN_ODD);
    runCompressor(CAN_FORWARD, canServo, "CAN");
  }
  else
  {
    triggerODD(PLASTIC_ODD);
    runCompressor(PLASTIC_FORWARD, plasticServo, "PLASTIC");
  }

  // The item has already been dumped. Waiting for an empty scale here left
  // the kiosk on "busy" whenever the load cell still read a few grams.
  goReady();
}
