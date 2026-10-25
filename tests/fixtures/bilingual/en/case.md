# FS0001_Login timeout

- **Case ID**: FS0001
- **Interface**: POST /api/login
- **Category**: Exception scenario
- **Module / Function**: Login module / Auth
- **Test objective**: Verify login timeout is rejected
- **Code reference**: src/login.py:10-20
- **Script**: verify.py
- **Test method**:
  1. Build timeout request
  2. Assert 401
- **Input parameters**:
  ```json
  { "user": "admin" }
  ```
- **Expected output**: Returns 401
- **Output retrieval**: Direct response
- **Verification logic**: code == 401
- **Note**: none
