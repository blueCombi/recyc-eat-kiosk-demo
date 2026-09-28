/*
  econova_vending.ino — EcoNova reward coils (ESP32 #2)

  Four coil motors behind relays. The kiosk redeem screen debits the points and
  the stock count, then asks this board to turn one coil; the reply is what the
  screen waits on, so every command is answered exactly once.

  Board: ESP32 dev module. Serial: 115200 baud, newline terminated.

  Host -> board
    WHO                 identify yourself
    PING                keep-alive
    DISPENSE|3          turn coil 3
    1 2 3 4             single characters still work in the Serial Monitor

  Board -> host
    HELLO|VEND|1
    PONG
    OK|DISPENSE|3               coil finished its turn
    ERR|DISPENSE|9|RANGE        no such coil
    ERR|DISPENSE|3|BUSY         another coil is still turning
    LOG|<free text>
*/
#define MOTOR1 25
#define MOTOR2 26
#define MOTOR3 27
#define MOTOR4 14

const int COIL_COUNT = 4;
const int COIL_PIN[COIL_COUNT] = { MOTOR1, MOTOR2, MOTOR3, MOTOR4 };

// One full turn per coil. Tune each spiral separately — a heavier pack needs
// longer than a light one.
const unsigned long COIL_MS[COIL_COUNT] = { 2000, 2000, 2000, 2000 };

String hostLine = "";
bool turning = false;

void logLine(const char *text)
{
  Serial.print("LOG|");
  Serial.println(text);
}

void dispense(int coil)
{
  if (coil < 1 || coil > COIL_COUNT)
  {
    Serial.print("ERR|DISPENSE|");
    Serial.print(coil);
    Serial.println("|RANGE");
    return;
  }

  if (turning)
  {
    Serial.print("ERR|DISPENSE|");
    Serial.print(coil);
    Serial.println("|BUSY");
    return;
  }

  turning = true;

  const int pin = COIL_PIN[coil - 1];

  digitalWrite(pin, LOW);          // Relay ON
  delay(COIL_MS[coil - 1]);
  digitalWrite(pin, HIGH);         // Relay OFF

  turning = false;

  Serial.print("OK|DISPENSE|");
  Serial.println(coil);
}

void handleHostLine(String line)
{
  line.trim();
  line.toUpperCase();

  if (line.length() == 0)
    return;

  if (line == "WHO")
  {
    Serial.println("HELLO|VEND|1");
    return;
  }

  if (line == "PING")
  {
    Serial.println("PONG");
    return;
  }

  if (line.startsWith("DISPENSE"))
  {
    const int bar = line.indexOf('|');
    dispense(bar < 0 ? 0 : line.substring(bar + 1).toInt());
    return;
  }

  // Typing a bare 1-4 in the Arduino Serial Monitor still works for bench tests.
  if (line.length() == 1 && line[0] >= '1' && line[0] <= '9')
  {
    dispense(line[0] - '0');
    return;
  }

  Serial.print("ERR|UNKNOWN|");
  Serial.println(line);
}

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

void setup()
{
  Serial.begin(115200);

  for (int i = 0; i < COIL_COUNT; i++)
  {
    pinMode(COIL_PIN[i], OUTPUT);
    digitalWrite(COIL_PIN[i], HIGH);   // relays idle
  }

  Serial.println("HELLO|VEND|1");
  logLine("coils 1-4 ready");
}

void loop()
{
  pollHost();
  delay(5);
}
