# Doctors

## Goal

Represent doctors and their configurable appointment slot duration.

---

# Doctor Configuration

Each doctor has a slot duration.

Allowed values:

- 15 minutes
- 30 minutes
- 60 minutes

The duration determines how available appointment slots are generated.

Example:

Doctor works:

10:00 → 12:00

Duration:

30 minutes

Available slots:

10:00
10:30
11:00
11:30

---

# Requirements

A doctor should be able to:

- view their profile/configuration
- configure slot duration

Doctors must not modify another doctor's configuration.

---

# Business Rules

Slot duration must be one of:

15, 30, 60.

Changing slot duration must not modify historical appointments.

Historical appointments retain their original start/end times.

The availability calculation uses the doctor's current configured slot duration.