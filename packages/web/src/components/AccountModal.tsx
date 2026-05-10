import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { AccountModalForm } from './AccountModalForm';

interface Account {
  id: number;
  name: string;
  provider: string;
  settings: string;
  session: string;
  enabled: number;
  created_at: string;
}

interface AccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingAccount: Account | null;
  onSave: (data: any) => Promise<void>;
}

export function AccountModal({ open, onOpenChange, editingAccount, onSave }: AccountModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <div key={editingAccount ? editingAccount.id : 'new'}>
          <DialogHeader>
            <DialogTitle>{editingAccount ? 'Edit Account' : 'Add New Account'}</DialogTitle>
            <DialogDescription>
              {editingAccount ? 'Update account details below.' : 'Fill in the account information.'}
            </DialogDescription>
          </DialogHeader>
          <AccountModalForm
            editingAccount={editingAccount}
            onSave={onSave}
            onCancel={() => onOpenChange(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
